// Fork: version comparison for update checks (pure, unit tested).
const parseVersion = (version: string) =>
  version
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

export const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
    }
  }

  return 0;
};
