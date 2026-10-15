function normalizeAmount(value) {
  const raw = String(value);
  if (!/^-?\d{1,24}(?:\.\d{1,6})?$/.test(raw)) throw new Error('金额必须是最多 6 位小数的十进制数');
  const neg = raw.startsWith('-');
  const unsigned = neg ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const normalizedAbs = `${whole}.${fraction.padEnd(6, '0')}`;
  return (neg && !/^0\.0{6}$/.test(normalizedAbs)) ? `-${normalizedAbs}` : normalizedAbs;
}
module.exports = { normalizeAmount };
