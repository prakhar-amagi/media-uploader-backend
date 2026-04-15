import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function fileExists(bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound") return false;
    throw err;
  }
}

export async function generateUploadUrl(bucket, key) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: "video/mp4"
  });

  return getSignedUrl(s3, command, { expiresIn: 300 });
}
