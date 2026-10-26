const secretKeyNames = [
  "accesskey",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secretaccesskey",
  "secretkey",
  "secrets",
  "token",
] as const;

export function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return secretKeyNames.some(
    (secretName) =>
      normalized === secretName ||
      normalized.endsWith(secretName) ||
      normalized.endsWith(`${secretName}s`),
  );
}
