/**
 * Module images - Compression et encodage des photos
 * Utilise sharp pour le redimensionnement et la compression
 */

import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Configuration de compression
 */
const COMPRESSION_CONFIG = {
  maxWidth: 1200,
  quality: 80,
  format: 'jpeg'
};

/**
 * Compresse une image et la sauve dans le dossier de sortie
 * @param {string} inputPath - Chemin de l'image source
 * @param {string} outputPath - Chemin de destination
 * @returns {Promise<{width: number, height: number, size: number}>} Métadonnées de l'image compressée
 */
export async function compressImage(inputPath, outputPath) {
  try {
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    
    const newWidth = Math.min(metadata.width || COMPRESSION_CONFIG.maxWidth, COMPRESSION_CONFIG.maxWidth);
    const newHeight = newWidth / (metadata.width / (metadata.height || 1));
    
    await image
      .withMetadata({ orientation: undefined }) // Applique la rotation basée sur EXIF
      .resize(newWidth, Math.round(newHeight), {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: COMPRESSION_CONFIG.quality })
      .toFile(outputPath);
    
    const outputMetadata = await sharp(outputPath).metadata();
    const stats = await fs.stat(outputPath);
    
    return {
      width: outputMetadata.width,
      height: outputMetadata.height,
      size: stats.size,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      originalSize: metadata.size || 0
    };
  } catch (error) {
    throw new Error(`Erreur lors de la compression de ${inputPath}: ${error.message}`);
  }
}

/**
 * Compresse toutes les images d'un dossier source vers un dossier de destination
 * @param {string} sourceDir - Dossier source des photos
 * @param {string} destDir - Dossier de destination (output/media/)
 * @returns {Promise<Array<{filename: string, path: string, metadata: object}>>} Liste des images compressées
 */
export async function compressAllImages(sourceDir, destDir) {
  try {
    await fs.mkdir(destDir, { recursive: true });
    const files = await fs.readdir(sourceDir);
    const compressedImages = [];
    
    for (const file of files) {
      const filePath = path.join(sourceDir, file);
      const stat = await fs.stat(filePath);
      
      if (!stat.isFile()) continue;
      
      const ext = path.extname(file).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext)) {
        console.warn(`Fichier ignoré (extension non supportée): ${file}`);
        continue;
      }
      
      const destPath = path.join(destDir, file);
      const metadata = await compressImage(filePath, destPath);
      
      compressedImages.push({
        filename: file,
        path: destPath,
        metadata
      });
      
      console.log(`  ✓ ${file} compressé (${metadata.originalWidth}x${metadata.originalHeight} -> ${metadata.width}x${metadata.height}, ${formatBytes(metadata.size)})`);
    }
    
    return compressedImages;
  } catch (error) {
    throw new Error(`Erreur lors de la compression des images: ${error.message}`);
  }
}

/**
 * Encode une image en base64
 * @param {string} filePath - Chemin du fichier image
 * @returns {Promise<string>} Image encodée en base64
 */
export async function encodeToBase64(filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let mimeType;
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        mimeType = 'image/jpeg';
        break;
      case '.png':
        mimeType = 'image/png';
        break;
      case '.webp':
        mimeType = 'image/webp';
        break;
      case '.heic':
      case '.heif':
        mimeType = 'image/heic';
        break;
      default:
        mimeType = 'image/jpeg';
    }
    
    return `data:${mimeType};base64,${data.toString('base64')}`;
  } catch (error) {
    throw new Error(`Erreur lors de l'encodage de ${filePath}: ${error.message}`);
  }
}

/**
 * Encode uniquement les images demandées d'un dossier en base64 (optimisé)
 * @param {string} dirPath - Dossier contenant les images
 * @param {string[]} filenames - Liste des noms de fichiers à encoder
 * @returns {Promise<Array<{filename: string, base64: string}>>}
 */
export async function encodeSelectedToBase64(dirPath, filenames) {
  if (!Array.isArray(filenames) || filenames.length === 0) return [];
  const uniqueFilenames = [...new Set(filenames.map(f => path.basename(f)))];
  const encodedImages = [];
  
  for (const filename of uniqueFilenames) {
    const filePath = path.join(dirPath, filename);
    try {
      const base64 = await encodeToBase64(filePath);
      encodedImages.push({ filename, base64 });
    } catch (error) {
      console.warn(`Image non trouvée pour encodage base64 (${filename}): ${error.message}`);
    }
  }
  return encodedImages;
}

/**
 * Encode toutes les images d'un dossier en base64
 * @param {string} dirPath - Dossier contenant les images
 * @returns {Promise<Array<{filename: string, base64: string}>>} Liste des images encodées
 */
export async function encodeAllToBase64(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    const encodedImages = [];
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = await fs.stat(filePath);
      
      if (!stat.isFile()) continue;
      
      const ext = path.extname(file).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext)) continue;
      
      const base64 = await encodeToBase64(filePath);
      encodedImages.push({
        filename: file,
        base64
      });
    }
    
    return encodedImages;
  } catch (error) {
    throw new Error(`Erreur lors de l'encodage des images: ${error.message}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default {
  compressImage,
  compressAllImages,
  encodeToBase64,
  encodeSelectedToBase64,
  encodeAllToBase64
};

