import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

/* Multipart upload: the file is split into parts that are sent in
   parallel, which is much faster than a single PUT for video files.
   Tunable from .env if needed. */
const PART_SIZE = Number(process.env.S3_PART_SIZE_MB || 8) * 1024 * 1024;   // S3 minimum is 5 MB
const QUEUE_SIZE = Number(process.env.S3_UPLOAD_CONCURRENCY || 4);           // parts in flight per file

/**
 * Upload a local file to S3 and return its CloudFront URL.
 * onProgress(loadedBytes, totalBytes) is called as parts complete.
 */
export async function uploadToS3(localPath, filename, onProgress) {

  const key =
    `${process.env.S3_PREFIX}/Promo/${filename}`;

  const total = fs.statSync(localPath).size;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: "video/mp4"
    },
    partSize: Math.max(PART_SIZE, 5 * 1024 * 1024),
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false
  });

  if (typeof onProgress === "function") {
    upload.on("httpUploadProgress", (p) => onProgress(p.loaded ?? 0, p.total ?? total));
  }

  await upload.done();
  if (typeof onProgress === "function") onProgress(total, total);

  return `${process.env.CF_BASE_URL}/Promo/${filename}`;
}
