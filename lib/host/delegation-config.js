/** @typedef {Readonly<{provider: string, model: string, reasoningEffort?: string}>} WorkerRoute */

/**
 * 将设置复制为不可变执行路由。空对象返回 null，非法数据抛 TypeError。
 * 不访问 live LLM，不创建 provider，不推测模型支持的推理等级。
 * @param {unknown} value
 * @returns {WorkerRoute|null}
 */
export function snapshotWorkerRoute(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('执行路由只接受普通对象、null 或 undefined。');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('执行路由必须是普通对象。');
  }

  const fields = { provider: '', model: '', reasoningEffort: '' };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(fields, key)) {
      throw new TypeError('执行路由包含未知字段。');
    }
    const field = value[key];
    if (typeof field !== 'string') {
      throw new TypeError(`执行路由字段 ${key} 必须为字符串。`);
    }
    fields[key] = field.trim();
  }

  const { provider, model, reasoningEffort } = fields;
  if (!provider && !model && !reasoningEffort) return null;
  if (!provider || !model) {
    throw new TypeError('执行路由必须同时指定 provider 和 model。');
  }
  return Object.freeze({
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });
}
