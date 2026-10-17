import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('i18n', () => {
  describe('locale files', () => {
    it('should have en, es, and pt locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const files = fs.readdirSync(localeDir);
      expect(files).toContain('en.json');
      expect(files).toContain('es.json');
      expect(files).toContain('pt.json');
    });

    it('should have valid JSON in all locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const locales = ['en', 'es', 'pt'];
      
      locales.forEach(locale => {
        const content = fs.readFileSync(
          path.join(localeDir, `${locale}.json`),
          'utf-8'
        );
        expect(() => JSON.parse(content)).not.toThrow();
      });
    });

    it('should have matching keys across all locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const locales = ['en', 'es', 'pt'];
      const messages: Record<string, any> = {};

      locales.forEach(locale => {
        const content = fs.readFileSync(
          path.join(localeDir, `${locale}.json`),
          'utf-8'
        );
        messages[locale] = JSON.parse(content);
      });

      // Get keys from English
      const enKeys = new Set(flattenKeys(messages.en));

      // Check that Spanish and Portuguese have the same keys
      const esKeys = new Set(flattenKeys(messages.es));
      const ptKeys = new Set(flattenKeys(messages.pt));

      // Find missing keys
      const missingInEs = [...enKeys].filter(k => !esKeys.has(k));
      const missingInPt = [...enKeys].filter(k => !ptKeys.has(k));

      expect(missingInEs).toHaveLength(0, `Missing keys in es.json: ${missingInEs.join(', ')}`);
      expect(missingInPt).toHaveLength(0, `Missing keys in pt.json: ${missingInPt.join(', ')}`);
    });
  });

  describe('locale parity with Action', () => {
    it('should support en, es, pt locales matching GitHub Action', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const files = fs.readdirSync(localeDir);
      
      // Action supports: en, es, pt
      const requiredLocales = ['en.json', 'es.json', 'pt.json'];
      requiredLocales.forEach(locale => {
        expect(files).toContain(locale);
      });
    });
  });
});

function flattenKeys(obj: any, prefix = ''): string[] {
  const keys: string[] = [];
  
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys.push(...flattenKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  
  return keys;
}
