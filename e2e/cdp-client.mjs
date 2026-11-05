const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal CDP client for one view of the app. */
export async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not connect to view"));
  });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  /** Runs like a click, for what browsers only allow after one, such as window.open. */
  const gesture = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, userGesture: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const waitFor = async (expression, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  return {
    send,
    evaluate,
    gesture,
    waitFor,
    errors,
    close: () => ws.close(),
    fill: (selector, value) => evaluate(`${q(selector)}.value = ${JSON.stringify(value)}`),
    click: (selector) => evaluate(`${q(selector)}.click()`),
    text: (selector) => evaluate(`${q(selector)}.innerText`),
    value: (selector) => evaluate(`${q(selector)}.value`),
    exists: (selector) => `!!${q(selector)}`,
  };
}
