// Shrinks phone photos before storing them: smaller files upload faster on a weak signal
// and keep the phone's storage use low. Text stays sharp at this size.

const MAX_EDGE = 2000;
const QUALITY = 0.82;
const THUMB_EDGE = 120;

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')); };
    img.src = url;
  });
}

function draw(img, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', quality);
  });
}

// Returns { blob, thumb } where thumb is a small data: URL for list rows.
export async function prepareImage(file) {
  const img = await loadImage(file);
  const blob = await toBlob(draw(img, MAX_EDGE), QUALITY);
  const thumb = draw(img, THUMB_EDGE).toDataURL('image/jpeg', 0.7);
  return { blob, thumb };
}
