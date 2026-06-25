import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";

const s3 = new S3Client({
  region: process.env.AWS_REGION
});

export async function uploadToS3(localPath, filename) {

  const key =
    `${process.env.S3_PREFIX}/Promo/${filename}`;

  const body = fs.createReadStream(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "video/mp4"
    })
  );

  return `${process.env.CF_BASE_URL}/Promo/${filename}`;
}