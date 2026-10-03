import QRCode from 'qrcode';

/** Renders a QR as a data URL with the pale stone palette. Local library, no network. */
export function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    margin: 1,
    width: 240,
    errorCorrectionLevel: 'M',
    color: { dark: '#0e2a2f', light: '#e9e3d3' },
  });
}
