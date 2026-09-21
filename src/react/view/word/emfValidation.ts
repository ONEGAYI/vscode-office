/** Bound the legacy parser before it receives untrusted document bytes. */
export function validateEmf(bytes: ArrayBuffer) {
    if (bytes.byteLength < 88 || bytes.byteLength > 2_000_000) throw new Error('EMF size limit');
    const v = new DataView(bytes);
    if (v.getUint32(0, true) !== 1 || v.getUint32(40, true) !== 0x464d4520) throw new Error('Invalid EMF header');
    const width = v.getInt32(16, true) - v.getInt32(8, true);
    const height = v.getInt32(20, true) - v.getInt32(12, true);
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('EMF dimensions limit');
    let offset = 0, count = 0, eof = false;
    while (offset + 8 <= bytes.byteLength) {
        const type = v.getUint32(offset, true), size = v.getUint32(offset + 4, true);
        if (size < 8 || size % 4 || offset + size > bytes.byteLength || ++count > 20000) throw new Error('Invalid EMF record');
        if (type === 1 && (offset !== 0 || size < 88)) throw new Error('Invalid EMF header record');
        // The imported parser allocates bitmap buffers from these records. Not supported in this first reader.
        if (type === 81) throw new Error('EMF embedded bitmap not supported');
        if (type === 34 && (size < 12 || v.getInt32(offset + 8, true) !== -1)) throw new Error('EMF restore level not supported');
        offset += size;
        if (type === 14) { eof = true; break; }
    }
    if (!eof || offset !== bytes.byteLength) throw new Error('Incomplete EMF');
    return { width, height };
}
