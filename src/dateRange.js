function parseDateRange(from, to) {
  const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!valid(from) || !valid(to)) throw new Error('日期必须为有效的 YYYY-MM-DD');
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  if (toMs < fromMs) throw new Error('结束日期不能早于开始日期');
  if (toMs - fromMs > 31 * 86400000) throw new Error('单次历史补扫最多 31 天，请分段执行');
  if (to > new Date().toISOString().slice(0, 10)) throw new Error('结束日期不能晚于今天（UTC）');
  return { fromMs, toMs };
}
module.exports = { parseDateRange };
