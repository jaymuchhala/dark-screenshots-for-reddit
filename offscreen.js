// The worker's way to the AI: its own fetches can't wait long enough, and it has no built-in model.
let running = null;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg.target !== 'offscreen') return;
  if (msg.type === 'ai-pick') {
    pickEngine(msg.choice).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === 'ai-cancel') running?.abort();
  if (msg.type === 'ai-ask') {
    const timeout = running = new AbortController();
    const timer = setTimeout(() => timeout.abort(), msg.timeoutMs);
    // null: no answer, so the checks decide.
    askEngine(msg.pick, msg.image, timeout.signal).then(reply, () => reply(null)).finally(() => clearTimeout(timer));
    return true;
  }
});
