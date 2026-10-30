import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// M4 (§9.8, §12): the classroom picture, four portraits, a complete
// cast.json, and masks assigned to the cast left to right. Total art
// stays under 500 KB.
const ROOT = join(__dirname, '..');
const cast = JSON.parse(readFileSync(join(ROOT, 'content', 'cast.json'), 'utf8')) as {
  classroom: string;
  masks: string;
  students: { id: string; name: string; description: string; voiceId: string; portrait: string }[];
};

function isWebP(path: string): boolean {
  const bytes = readFileSync(path);
  return (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

describe('classroom art', () => {
  it('cast.json names the four students with portraits and no picked voices', () => {
    expect(cast.classroom).toBe('art/classroom.webp');
    expect(cast.masks).toBe('art/classroom-masks.json');
    expect(cast.students.map((s) => s.id)).toEqual(['maya', 'leo', 'priya', 'sam']);
    for (const s of cast.students) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.portrait).toBe(`art/students/${s.id}.webp`);
      expect(s.voiceId).toBe('<pick>');
    }
  });

  it('all five pictures exist, are WebP, and total under 500 KB', () => {
    const files = [cast.classroom, ...cast.students.map((s) => s.portrait)];
    let total = 0;
    for (const file of files) {
      const path = join(ROOT, 'public', file);
      expect(existsSync(path), `missing public/${file}`).toBe(true);
      expect(isWebP(path), `${file} is not WebP`).toBe(true);
      total += statSync(path).size;
    }
    expect(total).toBeLessThan(500 * 1024);
  });

  it('masks cover the cast left to right with valid fractional boxes', () => {
    const path = join(ROOT, 'public', cast.masks);
    expect(existsSync(path), `missing public/${cast.masks}`).toBe(true);
    const masks = JSON.parse(readFileSync(path, 'utf8')) as {
      image: string;
      source: string;
      segments: { studentId: string; box: { x1: number; y1: number; x2: number; y2: number } }[];
    };
    expect(masks.image).toBe('art/classroom.webp');
    expect(['sam-3.1', 'hand']).toContain(masks.source);
    expect(masks.segments.map((s) => s.studentId)).toEqual(['maya', 'leo', 'priya', 'sam']);
    const centers = masks.segments.map((s) => {
      const { x1, y1, x2, y2 } = s.box;
      for (const v of [x1, y1, x2, y2]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(x1).toBeLessThan(x2);
      expect(y1).toBeLessThan(y2);
      return (x1 + x2) / 2;
    });
    expect([...centers].sort((a, b) => a - b)).toEqual(centers);
  });
});
