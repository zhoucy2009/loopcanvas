export function githubRepositoryURL(value) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { return ""; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return "";
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length !== 2) return "";
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return "";
  return `https://github.com/${owner}/${repository}`;
}
