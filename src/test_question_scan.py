import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('question_scan', Path(__file__).with_name('question-scan.py'))
mod = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(mod)
NOW = 1794384000000
STAMP = '2026-11-11T08:00:00Z'


def record(kind, payload, stamp=STAMP):
    return json.dumps({'timestamp': stamp, 'type': kind, 'payload': payload}) + '\n'


def answer(call='call_a', output=None):
    return record('response_item', {'type':'function_call_output', 'call_id':call, 'output':json.dumps({'accepted':True} if output is None else output)})


def question(call='call_a', name='request_user_input_async', args=None, accepted=True):
    return record('response_item', {'type': 'function_call', 'name': name, 'call_id': call,
        'arguments': json.dumps(args or {'questions': [{'title': '选择？', 'options': ['甲', '乙']}]})}) + (answer(call) if accepted else '')


class ScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.sessions = self.base/'sessions'; self.sessions.mkdir()
        self.db = self.base/'index.sqlite'; self.root = self.base/'private'
        c=sqlite3.connect(self.db)
        c.execute('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER,source TEXT,thread_source TEXT,agent_path TEXT,updated_at INTEGER)')
        c.close()
        self.path = self.sessions/'rollout.jsonl'
        self.path.write_text(record('session_meta', {'id':'chat_a'})+record('event_msg', {'type':'task_started','turn_id':'turn_a'}))
        self.register()

    def register(self, path=None, source='cli', thread_source='user', archived=0):
        c=sqlite3.connect(self.db);c.execute('DELETE FROM threads')
        c.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?)', ('chat_a',str(path or self.path),archived,source,thread_source,None,NOW//1000));c.commit();c.close()

    def append(self, value):
        with self.path.open('a') as f:f.write(value)

    def scan(self):return mod.scan(self.db,self.root,NOW-1000,NOW)
    def requests(self):return list((self.root/'requests').glob('*.json'))

    def test_normal_incremental_and_duplicate(self):
        self.append(question());self.assertEqual(self.scan()['created'],1)
        self.assertEqual(self.scan()['created'],0)
        self.append(question());self.assertEqual(self.scan()['duplicates'],1)
        data=json.loads(self.requests()[0].read_text())
        self.assertEqual(data['turnId'],'turn_a');self.assertEqual(data['callId'],'call_a')
        self.assertEqual(data['questions'][0]['options'],['甲','乙'])
        self.assertEqual(self.requests()[0].stat().st_mode & 0o777,0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777,0o700)

    def test_history_and_unsupported_sync(self):
        self.append(question().replace(STAMP,'2026-11-10T08:00:00Z'))
        self.append(question('call_b','request_user_input'))
        result=self.scan();self.assertEqual(result['outsideWindow'],1);self.assertEqual(result['unsupportedSync'],1)
        self.assertEqual(self.requests(),[])

    def test_partial_line_survives_poll(self):
        raw=question();self.append(raw[:80]);self.assertEqual(self.scan()['created'],0)
        self.append(raw[80:]);self.assertEqual(self.scan()['created'],1)

    def test_provenance_archive_and_wrong_session(self):
        self.append(question())
        for kwargs in [{'source':'{"subagent":true}'},{'thread_source':'unknown'},{'archived':1}]:
            self.register(**kwargs);self.assertEqual(self.scan()['created'],0)
        self.register();self.path.write_text(self.path.read_text().replace('chat_a','chat_b'))
        self.assertEqual(self.scan()['rejectedFiles'],1)

    def test_outside_and_symlink_rejected(self):
        outside=self.base/'outside.jsonl';outside.write_text(self.path.read_text()+question())
        self.register(outside);self.assertEqual(self.scan()['rejectedFiles'],1)
        link=self.sessions/'link.jsonl';link.symlink_to(outside)
        self.register(link);self.assertEqual(self.scan()['rejectedFiles'],1)
        self.register(self.sessions/'..'/'outside.jsonl');self.assertEqual(self.scan()['rejectedFiles'],1)

    def test_invalid_questions_do_not_change_content(self):
        self.append(question(args={'questions':[{'title':'x'*1001}]}))
        self.append(question('call_b',args={'questions':[{'title':'Title','options':[{'label':'x'}]}]}))
        self.append(question('call_c',args={'questions':[{'title':'Free text'}]}))
        self.assertEqual(self.scan()['created'],1)
        self.assertEqual(json.loads(self.requests()[0].read_text())['questions'],[{'title':'Free text','options':[]}])

    def test_new_inode_and_new_turn(self):
        self.append(question());self.scan()
        self.path.unlink();self.path.write_text(record('session_meta',{'id':'chat_a'})+record('turn_context',{'turn_id':'turn_b'})+question('call_b'))
        self.assertEqual(self.scan()['created'],1)
        self.assertEqual({json.loads(p.read_text())['turnId'] for p in self.requests()},{'turn_a','turn_b'})

    def test_private_state_symlink_rejected(self):
        self.scan();state=self.root/'scanner-state.json';state.unlink();state.symlink_to(self.path)
        with self.assertRaises(ValueError):self.scan()

    def test_resume_cutoff_drops_pause_questions(self):
        self.scan();self.append(question())
        self.assertEqual(mod.scan(self.db,self.root,NOW+1000,NOW+1000)['created'],0)


    def test_long_turn_keeps_identity_across_bounded_polls(self):
        self.append(record('response_item', {'type':'message','content':'x'*(mod.MAX_CHUNK*2)}))
        self.append(question())
        for _ in range(5):self.scan()
        self.assertEqual(len(self.requests()),1)
        self.assertEqual(json.loads(self.requests()[0].read_text())['turnId'],'turn_a')

    def test_budget_rotates_without_starving_threads(self):
        original=mod.MAX_TOTAL;mod.MAX_TOTAL=mod.MAX_CHUNK
        self.addCleanup(setattr,mod,'MAX_TOTAL',original)
        c=sqlite3.connect(self.db);c.execute('DELETE FROM threads')
        for i in range(3):
            path=self.sessions/f'rollout_{i}.jsonl';sid=f'chat_{i}'
            path.write_text(record('session_meta',{'id':sid})+record('event_msg',{'type':'task_started','turn_id':'turn_a'})+
                record('response_item',{'type':'message','content':'x'*(mod.MAX_CHUNK*2)})+question())
            c.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?)',(sid,str(path),0,'cli','user',None,NOW//1000+i))
        c.commit();c.close()
        for _ in range(12):self.scan()
        self.assertEqual(len(self.requests()),3)


    def test_requires_accepted_output_across_polls(self):
        self.append(question(accepted=False));self.assertEqual(self.scan()['created'],0)
        self.assertEqual(len(json.loads((self.root/'scanner-state.json').read_text())['pending']),1)
        self.append(answer());self.assertEqual(self.scan()['created'],1)
        self.assertEqual(json.loads((self.root/'scanner-state.json').read_text())['pending'],{})

    def test_failed_or_unknown_output_never_publishes(self):
        for i,output in enumerate([{'accepted':False},{'error':'failed'},{'accepted':1},'unknown']):
            call=f'call_{i}';self.append(question(call,accepted=False)+answer(call,output))
        self.assertEqual(self.scan()['unacceptedQuestions'],4)
        self.assertEqual(self.requests(),[])

    def test_accepted_output_after_large_chunk_retains_question(self):
        self.append(question(accepted=False))
        self.append(record('response_item',{'type':'message','content':'x'*(mod.MAX_CHUNK*2)}))
        self.append(answer())
        for _ in range(5):self.scan()
        self.assertEqual(len(self.requests()),1)


    def native(self, title='选择？', call='call_a', role='user', prefix=''):
        reply=[{'questionItemId':json.dumps(['request_user_input_async',call,0]),'question':title,'answer':'甲'}]
        return record('response_item', {'type':'message','role':role,'content':[{'type':'input_text','text':prefix+'<send_user_message_question_reply>\n'+json.dumps(reply)+'\n</send_user_message_question_reply>'}]})

    def test_native_answer_resolves_only_matching_snapshot_without_answer_text(self):
        self.append(question());self.scan();self.append(self.native())
        self.assertEqual(self.scan()['resolvedNative'],1)
        request=json.loads(self.requests()[0].read_text())
        resolved=json.loads((self.root/'resolved'/self.requests()[0].name).read_text())
        self.assertEqual(resolved,{'version':1,'eventId':request['eventId'],'resolvedBy':'codex'})
        self.assertNotIn('甲',json.dumps(resolved,ensure_ascii=False))

    def test_wrong_native_role_text_call_or_question_cannot_resolve(self):
        self.append(question());self.scan()
        for options in [{'title':'Different question'},{'call':'wrong_call'},{'role':'assistant'},{'prefix':'ordinary text '}]:
            self.append(self.native(**options))
        self.assertEqual(self.scan()['resolvedNative'],0)
        self.assertEqual(list((self.root/'resolved').glob('*.json')),[])

    def test_wrong_session_snapshot_cannot_resolve(self):
        self.append(question());self.scan()
        p=self.requests()[0];request=json.loads(p.read_text());request['sessionId']='other';p.write_text(json.dumps(request))
        self.append(self.native());self.assertEqual(self.scan()['resolvedNative'],0)


if __name__=='__main__':unittest.main()
