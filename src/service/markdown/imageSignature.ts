/** Identify common clipboard image formats using only a bounded file header. */
export function detectClipboardImageExtension(header: Uint8Array): string | undefined {
    const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte);
    const asciiAt = (offset: number, text: string) =>
        [...text].every((char, index) => header[offset + index] === char.charCodeAt(0));

    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
    if (startsWith(0xff, 0xd8, 0xff)) return 'jpg';
    if (asciiAt(0, 'GIF87a') || asciiAt(0, 'GIF89a')) return 'gif';
    if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'webp';
    if (asciiAt(0, 'BM')) return 'bmp';
    if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return 'tif';
    if (startsWith(0x00, 0x00, 0x01, 0x00)) return 'ico';
    if (asciiAt(4, 'ftyp')) {
        if (asciiAt(8, 'avif') || asciiAt(8, 'avis')) return 'avif';
        if (['heic', 'heix', 'hevc', 'hevx'].some(brand => asciiAt(8, brand))) return 'heic';
    }
    return undefined;
}
