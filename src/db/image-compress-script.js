import sharp from 'sharp';
import Joi from 'joi';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime-types';

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  albumArtDirectory: Joi.string().required(),
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

run();

async function run() {
  let files;
  try {
    files = await fs.readdir(loadJson.albumArtDirectory);
  } catch (err) {
    console.log(err);
    process.exit(1);
  }

  for (const file of files) {
    let filepath;
    try {
      filepath = path.join(loadJson.albumArtDirectory, file);
      const stat = await fs.stat(filepath);
      if (stat.isDirectory()) { continue; }
      const mimeType = mime.lookup(path.extname(file));
      if (!mimeType.startsWith('image')) { continue; }
      if (file.startsWith('zs-') || file.startsWith('zl-') || file.startsWith('zm-')) { continue; }

      await sharp(filepath).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zl-' + file));
      await sharp(filepath).resize(92, 92, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zs-' + file));
    } catch (error) {
      console.log('error on file: ' + filepath);
      console.error(error);
    }
  }
}
