// src/utils/filename.js

export function sanitizeFilename(originalName) {
  if (!originalName) return '';
  
  // Remove spaces before .mp4
  let name = originalName.replace(/\s+\.mp4$/, '.mp4');

  // Replace remaining spaces with underscores
  name = name.replace(/\s+/g, '_');

  return name;
}
