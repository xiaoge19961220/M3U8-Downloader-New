const GENERIC_NAMES = new Set(['index', 'master', 'playlist', 'stream', 'live', 'hls', 'm3u8', 'chunklist']);

function inferTaskName(source) {
  if (typeof source !== 'string' || !source.trim()) return '';
  let pathname;
  try {
    pathname = new URL(source.trim()).pathname;
  } catch (error) {
    return '';
  }

  const parts = pathname.split('/').filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index--) {
    let name = parts[index];
    try { name = decodeURIComponent(name); } catch (error) { /* Keep the original path component. */ }
    name = name.replace(/\.m3u8?$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[.\s]+$/g, '').trim();
    if (!name || GENERIC_NAMES.has(name.toLowerCase()) || /^\d+$/.test(name) || /^[a-z]:$/i.test(name)) continue;
    return name.slice(0, 80);
  }
  return '';
}

module.exports = { inferTaskName };
