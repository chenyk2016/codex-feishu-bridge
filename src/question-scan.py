#!/usr/bin/env python3
"""Bounded, read-only rollout adapter for explicit async questions (not a stable Codex API)."""
import argparse
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time

ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
MAX_CHUNK = 1024 * 1024
MAX_TOTAL = 8 * MAX_CHUNK
MAX_THREADS = 512
MAX_STATE = 4 * MAX_CHUNK


def safe_info(path, directory=False, private=False):
    info = path.lstat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('unsafe_path')
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('unsafe_path')
    if private and stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600):
        raise ValueError('unsafe_path')
    return info


def safe_tree(path, base):
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("unsafe_path")
    path.relative_to(base)
    current = base
    safe_info(current, directory=True)
    for component in path.relative_to(base).parts[:-1]:
        current /= component
        safe_info(current, directory=True)
    return safe_info(path)


def atomic_json(path, value):
    if path.exists() or path.is_symlink():
        safe_info(path, private=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.question-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_state(path, since_ms):
    if not path.exists() and not path.is_symlink():
        return {'version': 1, 'activatedAtMs': since_ms, 'files': {}}
    safe_info(path, private=True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        raw = stream.read(MAX_STATE + 1)
    if len(raw) > MAX_STATE:
        raise ValueError('state_too_large')
    value = json.loads(raw)
    if (value.get('version') != 1 or type(value.get('activatedAtMs')) is not int
            or value['activatedAtMs'] <= 0
            or not isinstance(value.get('files'), dict) or len(value['files']) > MAX_THREADS):
        raise ValueError('invalid_state')
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp_required')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timezone_required')
    return int(dt.timestamp() * 1000)


def normalize_questions(arguments):
    args = json.loads(arguments) if isinstance(arguments, str) else None
    if not isinstance(args, dict) or set(args) != {'questions'}:
        raise ValueError('invalid_question_arguments')
    questions = args['questions']
    if not isinstance(questions, list) or not 1 <= len(questions) <= 3:
        raise ValueError('invalid_questions')
    result = []
    for question in questions:
        if not isinstance(question, dict) or set(question) - {'title', 'options'}:
            raise ValueError('invalid_question')
        title, options = question.get('title'), question.get('options', [])
        if not isinstance(title, str) or not title.strip() or len(title) > 1000 or '\0' in title:
            raise ValueError('invalid_title')
        if (not isinstance(options, list) or len(options) > 8 or any(not isinstance(v, str)
                or not v.strip() or len(v) > 300 or '\0' in v for v in options)):
            raise ValueError('invalid_options')
        result.append({'title': title, 'options': options})
    return result


def resolve_native_reply(payload, session_id, created, destination, resolved, counts):
    """Only exact native reply envelopes can retire an existing matching question snapshot."""
    if payload.get('type') != 'message' or payload.get('role') != 'user':
        return
    content = payload.get('content')
    if not isinstance(content, list):
        return
    start, end = '<send_user_message_question_reply>', '</send_user_message_question_reply>'
    for item in content:
        text = item.get('text') if isinstance(item, dict) else None
        if not isinstance(text, str) or len(text) > 32768:
            continue
        text = text.strip()
        if not text.startswith(start) or not text.endswith(end):
            continue
        try:
            replies = json.loads(text[len(start):-len(end)].strip())
            if not isinstance(replies, list) or not 1 <= len(replies) <= 3:
                continue
            parsed = []
            for reply in replies:
                if not isinstance(reply, dict) or set(reply) != {'questionItemId', 'question', 'answer'}:
                    continue
                identity = json.loads(reply['questionItemId'])
                if (not isinstance(identity, list) or len(identity) != 3
                        or identity[0] != 'request_user_input_async'
                        or not isinstance(identity[1], str) or not ID.fullmatch(identity[1])
                        or type(identity[2]) is not int or not 0 <= identity[2] < 3
                        or not isinstance(reply['question'], str) or not isinstance(reply['answer'], str)):
                    continue
                parsed.append((identity[1], identity[2], reply['question']))
            if not parsed:
                continue
            for index, path in enumerate(destination.iterdir()):
                if index >= 4096:
                    counts['resolutionLimited'] += 1
                    break
                if not re.fullmatch(r'[a-f0-9]{64}\.json', path.name):
                    continue
                try:
                    safe_info(path, private=True)
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd, 'rb') as stream:
                        raw = stream.read(32769)
                    if len(raw) > 32768:
                        continue
                    request = json.loads(raw)
                    if (request.get('version') != 1 or request.get('kind') != 'codex_async_question'
                            or request.get('sessionId') != session_id
                            or request.get('eventId') != path.stem
                            or type(request.get('createdAtMs')) is not int or created < request['createdAtMs']):
                        continue
                    expected = sha256(f"{session_id}\0{request['turnId']}\0{request['callId']}".encode()).hexdigest()
                    if expected != path.stem:
                        continue
                    questions = request.get('questions', [])
                    if any(call_id == request.get('callId') and question_index < len(questions)
                           and questions[question_index].get('title') == title
                           for call_id, question_index, title in parsed):
                        target = resolved / path.name
                        atomic_json(target, {'version': 1, 'eventId': path.stem, 'resolvedBy': 'codex'})
                        counts['resolvedNative'] += 1
                except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
                    counts['invalidRecords'] += 1
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
            counts['invalidRecords'] += 1


def scan_file(path, sessions, session_id, cursor, cutoff, now, destination, budget, counts, pending, resolved):
    before = safe_tree(path, sessions)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('file_changed')
        header = stream.readline(65537)
        meta = json.loads(header)
        if (len(header) > 65536 or meta.get('type') != 'session_meta'
                or meta.get('payload', {}).get('id') != session_id):
            raise ValueError('wrong_session')
        identity = [info.st_dev, info.st_ino]
        if (not isinstance(cursor, dict) or cursor.get('identity') != identity
                or type(cursor.get('offset')) is not int or not 0 <= cursor['offset'] <= info.st_size):
            cursor = {'identity': identity, 'offset': 0, 'turnId': None, 'dropping': False}
        stream.seek(cursor['offset'])
        chunk = stream.read(min(MAX_CHUNK, budget))
        consumed = chunk.rfind(b'\n') + 1
        if not consumed:
            if len(chunk) == MAX_CHUNK:
                cursor['offset'] += len(chunk)
                cursor['dropping'] = True
                counts['oversizeLines'] += 1
                return cursor, len(chunk)
            return cursor, len(chunk)
        lines = chunk[:consumed].splitlines()
        if cursor.get('dropping'):
            lines = lines[1:]
            cursor['dropping'] = False
        for line in lines:
            try:
                record = json.loads(line)
                payload = record.get('payload', {})
                if not isinstance(payload, dict):
                    continue
                if record.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
                    reply_time = timestamp(record.get('timestamp'))
                    if cutoff <= reply_time <= now + 30000:
                        resolve_native_reply(payload, session_id, reply_time, destination, resolved, counts)
                if record.get('type') == 'turn_context':
                    candidate = payload.get('turn_id', payload.get('id'))
                    cursor['turnId'] = candidate if isinstance(candidate, str) and ID.fullmatch(candidate) else None
                elif record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
                    candidate = payload.get('turn_id')
                    cursor['turnId'] = candidate if isinstance(candidate, str) and ID.fullmatch(candidate) else None
                if record.get('type') == 'response_item' and payload.get('type') == 'function_call_output':
                    call_id = payload.get('call_id')
                    if not isinstance(call_id, str):
                        continue
                    candidate = pending.pop(session_id + ':' + call_id, None)
                    if candidate is None:
                        continue
                    try:
                        output = json.loads(payload.get('output'))
                    except (ValueError, TypeError):
                        output = None
                    output_turn = payload.get('internal_chat_message_metadata_passthrough', {})
                    output_turn = output_turn.get('turn_id') if isinstance(output_turn, dict) else None
                    if (output != {'accepted': True} or type(output.get('accepted')) is not bool
                            or (output_turn is not None and output_turn != candidate['turnId'])):
                        counts['unacceptedQuestions'] += 1
                        continue
                    target = destination / (candidate['eventId'] + '.json')
                    if target.exists() or target.is_symlink():
                        safe_info(target, private=True)
                        counts['duplicates'] += 1
                    else:
                        atomic_json(target, candidate)
                        counts['created'] += 1
                    continue
                if record.get('type') != 'response_item' or payload.get('type') != 'function_call':
                    continue
                name = payload.get('name')
                if name not in ('request_user_input_async', 'request_user_input'):
                    continue
                created = timestamp(record.get('timestamp'))
                if created < cutoff or created > now + 30000:
                    counts['outsideWindow'] += 1
                    continue
                if name == 'request_user_input':
                    counts['unsupportedSync'] += 1
                    continue
                call_id, turn_id = payload.get('call_id'), cursor.get('turnId')
                if not isinstance(call_id, str) or not ID.fullmatch(call_id) or not turn_id:
                    counts['unboundQuestions'] += 1
                    continue
                questions = normalize_questions(payload.get('arguments'))
                event_id = sha256(f'{session_id}\0{turn_id}\0{call_id}'.encode()).hexdigest()
                key = session_id + ':' + call_id
                if key not in pending and len(pending) >= 64:
                    counts['pendingLimited'] += 1
                    continue
                pending[key] = {'version': 1, 'kind': 'codex_async_question', 'eventId': event_id,
                    'sessionId': session_id, 'turnId': turn_id, 'callId': call_id,
                    'createdAtMs': created, 'questions': questions}
            except (ValueError, TypeError, AttributeError, UnicodeError, RecursionError):
                counts['invalidRecords'] += 1
        cursor['offset'] += consumed
        return cursor, len(chunk)


def scan(database, root, since_ms, now_ms=None):
    database, root = Path(database), Path(root)
    now_ms = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    if not database.is_absolute() or not root.is_absolute() or type(since_ms) is not int or not 0 < since_ms <= now_ms:
        raise ValueError('invalid_arguments')
    safe_info(database)
    safe_info(database.parent, directory=True)
    root.mkdir(mode=0o700, parents=False, exist_ok=True)
    safe_info(root, directory=True, private=True)
    requests = root / 'requests'; requests.mkdir(mode=0o700, exist_ok=True)
    safe_info(requests, directory=True, private=True)
    resolved = root / 'resolved'; resolved.mkdir(mode=0o700, exist_ok=True)
    safe_info(resolved, directory=True, private=True)
    lock_fd = os.open(root / 'scanner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        safe_info(root / 'scanner.lock', private=True)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(root / 'scanner-state.json', since_ms)
        cutoff = max(since_ms, state['activatedAtMs'])
        pending = state.get('pending', {})
        if not isinstance(pending, dict) or len(pending) > 64:
            raise ValueError('invalid_pending')
        pending = {k: v for k, v in pending.items() if isinstance(v, dict)
                   and type(v.get('createdAtMs')) is int and max(cutoff, now_ms - 1800000) <= v['createdAtMs'] <= now_ms + 30000}

        counts = dict.fromkeys(['scanned', 'created', 'duplicates', 'outsideWindow', 'unsupportedSync',
                               'unboundQuestions', 'invalidRecords', 'rejectedFiles', 'tailLimited',
                               'oversizeLines', 'budgetLimited', 'threadLimited', 'unchangedBeforeActivation', 'unacceptedQuestions', 'pendingLimited', 'resolvedNative', 'resolutionLimited'], 0)
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=0.5)
        try:
            connection.execute('PRAGMA query_only = ON')
            rows = connection.execute("SELECT id, rollout_path FROM threads WHERE archived=0 AND source IN ('cli','exec','vscode') AND thread_source IN ('user','chatgpt_handoff','codex','agent_created_thread') AND (agent_path IS NULL OR agent_path='') ORDER BY updated_at DESC LIMIT ?", (MAX_THREADS + 1,)).fetchall()
        finally:
            connection.close()
        counts['threadLimited'] = int(len(rows) > MAX_THREADS)
        selected = rows[:MAX_THREADS]
        rotation = state.get('rotation', 0)
        rotation = rotation % len(selected) if selected and type(rotation) is int else 0
        selected = selected[rotation:] + selected[:rotation]
        budget, files, visited = MAX_TOTAL, {}, 0
        for session_id, path in selected:
            if not isinstance(session_id, str) or not ID.fullmatch(session_id) or not isinstance(path, str):
                counts['rejectedFiles'] += 1; continue
            old = state['files'].get(session_id)
            if budget <= 0:
                if old: files[session_id] = old
                counts['budgetLimited'] += 1
                continue
            try:
                if old is None and safe_tree(Path(path), database.parent / 'sessions').st_mtime_ns // 1000000 < cutoff:
                    counts['unchangedBeforeActivation'] += 1
                    continue
                visited += 1
                cursor, read = scan_file(Path(path), database.parent / 'sessions', session_id, old,
                    cutoff, now_ms, requests, budget, counts, pending, resolved)
                files[session_id] = cursor
                budget -= read
                counts['scanned'] += 1
            except (OSError, ValueError, TypeError, AttributeError, RecursionError):
                counts['rejectedFiles'] += 1
        state['rotation'] = (rotation + max(1, visited)) % max(1, len(selected))
        state['files'] = files
        state['pending'] = pending
        atomic_json(root / 'scanner-state.json', state)
        return counts
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--since-ms', required=True, type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(scan(args.database, args.root, args.since_ms)))
        return 0
    except Exception:
        sys.stderr.write('question_scan_unavailable\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
