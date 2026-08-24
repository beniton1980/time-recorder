export function generateStorePosterPdf(input: {
  storeName: string;
  qrPngDataUrl: string;
}): Promise<Buffer>;
