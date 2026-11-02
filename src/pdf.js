/**
 * Module pdf - Génération de PDF via Puppeteer et prévisualisation
 */

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import open from 'open';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUPPETEER_CONFIG = {
  format: 'A4',
  margin: {
    top: '14mm',
    right: '14mm',
    bottom: '14mm',
    left: '14mm'
  },
  printBackground: true,
  headless: true
};

function getExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const defaultChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (existsSync(defaultChrome)) {
    return defaultChrome;
  }
  return undefined; // Puppeteer utilisera son binaire par défaut
}

/**
 * Génère un PDF à partir d'un HTML
 * @param {string} html - Contenu HTML
 * @param {string} outputPath - Chemin du fichier PDF de sortie
 * @returns {Promise<{path: string, size: number}>} Chemin et taille du PDF généré
 */
export async function generatePdf(html, outputPath) {
  let browser;
  
  try {
    const launchOptions = {
      headless: PUPPETEER_CONFIG.headless,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu']
    };

    const execPath = getExecutablePath();
    if (execPath) {
      launchOptions.executablePath = execPath;
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    await page.setContent(html, {
      waitUntil: 'networkidle0'
    });
    
    await page.waitForFunction(() => {
      const images = document.querySelectorAll('img');
      return Array.from(images).every(img => img.complete);
    }, { timeout: 30000 });
    
    const pdfBuffer = await page.pdf({
      format: PUPPETEER_CONFIG.format,
      margin: PUPPETEER_CONFIG.margin,
      printBackground: PUPPETEER_CONFIG.printBackground,
      preferCSSPageSize: true
    });
    
    await fs.writeFile(outputPath, pdfBuffer);
    const stats = await fs.stat(outputPath);
    
    return {
      path: outputPath,
      size: stats.size
    };
  } catch (error) {
    throw new Error(`Erreur lors de la génération du PDF: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Génère un PDF à partir d'un fichier HTML
 * @param {string} htmlPath - Chemin du fichier HTML
 * @param {string} outputPath - Chemin du fichier PDF de sortie
 * @returns {Promise<{path: string, size: number}>} Chemin et taille du PDF généré
 */
export async function generatePdfFromHtmlFile(htmlPath, outputPath) {
  try {
    const html = await fs.readFile(htmlPath, 'utf8');
    return await generatePdf(html, outputPath);
  } catch (error) {
    throw new Error(`Erreur lors de la lecture du fichier HTML: ${error.message}`);
  }
}

/**
 * Prévisualise un HTML dans le navigateur par défaut
 * @param {string} htmlPath - Chemin du fichier HTML à ouvrir
 */
export async function previewHtml(htmlPath) {
  try {
    await open(htmlPath);
  } catch (error) {
    console.warn(`Impossible d'ouvrir le navigateur automatiquement: ${error.message}`);
    console.log(`Vous pouvez ouvrir le fichier manuellement: ${htmlPath}`);
  }
}

export default {
  generatePdf,
  generatePdfFromHtmlFile,
  previewHtml
};

