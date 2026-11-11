/** Acknowledge navigation immediately; deliver fresh cards outside the callback response. */
export function createNavigationDelivery({ router, sendControl, sendText, isAllowed = () => true, onSwitched = () => {}, log = () => {} }) {
  const seen = new Set();
  const pending = new Set();
  let chain = Promise.resolve();
  const accepts = value => ['select_session', 'session_page'].includes(value?.route) ||
    (value?.route === 'session_menu' && ['switch_chat', 'current_chat'].includes(value.action));

  // Authentication remains in the caller; the router also checks issued controls and message binding.
  function receive({ value, messageId, eventId }) {
    const key = JSON.stringify([messageId, value]);
    if (!accepts(value)) throw new Error('unsupported_navigation');
    if ((eventId && seen.has(eventId)) || pending.has(key)) return { toast: { type: 'info', content: '已收到，请查看后续消息。' } };
    if (pending.size >= 8) return { toast: { type: 'warning', content: '正在处理聊天操作，请稍后再试。' } };
    if (eventId) {
      seen.add(eventId);
      if (seen.size > 512) seen.delete(seen.values().next().value);
    }
    pending.add(key);
    log('session_navigation_received', { route: value.route, action: value.action });
    // A separate event-loop turn lets the SDK send the callback response before metadata reads.
    chain = chain.then(() => new Promise(resolve => setImmediate(resolve))).then(async () => {
      const started = Date.now();
      let switched = false;
      try {
        if (!isAllowed()) return;
        const result = router.handleControlAction(value, messageId, Date.now(), { newMessage: true });
        switched = result.status === 'switched';
        if (switched) onSwitched();
        if (!result.card) {
          await sendText('这张列表已使用或过期，请点击管理卡的“切换聊天”，或发送“切换聊天”获取新列表。');
          log('session_navigation_rejected', { status: result.status });
          return;
        }
        if (!isAllowed()) return;
        await sendControl(result);
        log('session_navigation_delivered', { status: result.status, durationMs: Date.now() - started });
      } catch (error) {
        log('session_navigation_failed', { durationMs: Date.now() - started,
          code: typeof error?.code === 'number' ? error.code : 'navigation_delivery_failed', switched });
        if (isAllowed()) {
          try { await sendText(switched
            ? '聊天已切换，但确认卡发送失败。请发送“当前聊天”核对目标。'
            : '未能发送聊天列表。请重新点击“切换聊天”，或直接发送“切换聊天”。'); }
          catch { log('session_navigation_notice_failed'); }
        }
      } finally { pending.delete(key); }
    });
    return { toast: { type: 'info', content: '已收到，结果将另发一条消息。' } };
  }
  return { accepts, receive, idle: () => chain };
}
