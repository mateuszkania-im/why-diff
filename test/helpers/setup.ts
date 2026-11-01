/**
 * Every git process the tests (and the code under test) start inherits this: no CRLF conversion,
 * whatever the machine's git config says (Windows runners set core.autocrlf=true), so temp repos
 * hold exactly the bytes the tests wrote.
 */
const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
const extra: Array<[string, string]> = [['core.autocrlf', 'false'], ['core.safecrlf', 'false']];
extra.forEach(([k, v], i) => {
  process.env[`GIT_CONFIG_KEY_${n + i}`] = k;
  process.env[`GIT_CONFIG_VALUE_${n + i}`] = v;
});
process.env.GIT_CONFIG_COUNT = String(n + extra.length);
