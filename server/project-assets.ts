export const MAX_FIGURE_BYTES = 8 * 1024 * 1024;
export function decodeFigure(body: Record<string, unknown>) {
  const { filename, contentType, data } = body;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255)
    throw new Error('A figure filename of at most 255 characters is required.');
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(MAX_FIGURE_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('Invalid image data. Figures must be at most 8 MB.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('Invalid base64 image data.');
  if (!bytes.length || bytes.length > MAX_FIGURE_BYTES)
    throw new Error('Figures must be between 1 byte and 8 MB.');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp =
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!(
    (contentType === 'image/png' && png) ||
    (contentType === 'image/jpeg' && jpeg) ||
    (contentType === 'image/gif' && gif) ||
    (contentType === 'image/webp' && webp)
  ))
    throw new Error(
      'Upload a PNG, JPEG, GIF, or WebP image. The image content must match its type.',
    );
  return {
    filename: filename.replace(/[\\/\r\n]/g, '_'),
    contentType: contentType as string,
    data: bytes,
  };
}
