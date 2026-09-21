import JSZip from 'jszip';

/** Until the editor preserves object markup on save, these documents are view-only. */
export async function hasEmbeddedOfficeObjects(buffer: ArrayBuffer): Promise<boolean> {
    const zip = await JSZip.loadAsync(buffer);
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir || !/^word\/.*\.(?:xml|rels)$/i.test(name)) continue;
        const xml = await entry.async('string');
        if (/<(?:[\w.-]+:)?(?:OLEObject|objectEmbed|objectLink)\b/.test(xml) || /\/relationships\/(?:oleObject|package)["']/.test(xml)) return true;
    }
    return false;
}
