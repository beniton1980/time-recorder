import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const KEY_ENV_NAME = "ONOGAMI_STORE_QR_ENCRYPTION_KEY";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function encryptionKey() {
  const encoded = process.env[KEY_ENV_NAME];
  if (!encoded) {
    throw new Error("STORE_QR_ENCRYPTION_KEY_NOT_CONFIGURED");
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("STORE_QR_ENCRYPTION_KEY_INVALID");
  }
  return key;
}

function additionalData(storeId: string) {
  return Buffer.from(`onogami-store-qr:${storeId}`, "utf8");
}

export function encryptStoreEntryToken(rawToken: string, storeId: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(storeId));

  const ciphertext = Buffer.concat([
    cipher.update(rawToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptStoreEntryToken(sealedToken: string, storeId: string) {
  const [version, ivPart, tagPart, ciphertextPart, ...extra] = sealedToken.split(".");
  if (
    version !== VERSION
    || !ivPart
    || !tagPart
    || !ciphertextPart
    || extra.length > 0
  ) {
    throw new Error("STORE_QR_CIPHERTEXT_INVALID");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAAD(additionalData(storeId));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("STORE_QR_CIPHERTEXT_INVALID");
  }
}
