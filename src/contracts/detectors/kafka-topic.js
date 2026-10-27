import fs from 'fs';
import path from 'path';
import { capFiles, globFiles } from '../../utils/glob.js';

export class KafkaTopicDetector {
  async detect(subproject) {
    const surfaces = [];

    const kafkaFiles = await globFiles(
      [
        '**/kafka/**/*.{yml,yaml,properties,json}',
        '**/kafka*.{yml,yaml,properties,json}',
        '**/topics.{yml,yaml,json}',
        '**/events.{yml,yaml,json}',
      ],
      { cwd: subproject.root, absolute: true, ignore: ['**/vendor/**'] }
    );

    for (const f of kafkaFiles) {
      const content = fs.readFileSync(f, 'utf-8');
      const ext = path.extname(f);

      if (ext === '.json') {
        try {
          const data = JSON.parse(content);
          const topics = Array.isArray(data) ? data : data.topics || data.events || [];
          for (const t of topics) {
            const name = typeof t === 'string' ? t : t.name || t.topic;
            if (name) {
              surfaces.push({
                path: path.relative(subproject.root, f),
                symbol: `kafka:${name}`,
                kind: 'event',
                lang: 'json',
                startLine: Math.max(1, content.slice(0, Math.max(0, content.indexOf(JSON.stringify(name)))).split('\n').length),
                metadata: { type: 'kafka_topic', topic: name, registry: path.basename(f) },
              });
            }
          }
        } catch {}
      } else {
        const topicMatches = content.matchAll(/(?:topic|topicName|name):\s*['"]?([\w.-]+)['"]?/gi);
        for (const m of topicMatches) {
          surfaces.push({
            path: path.relative(subproject.root, f),
            symbol: `kafka:${m[1]}`,
            kind: 'event',
            lang: ext.slice(1),
            startLine: content.slice(0, m.index).split('\n').length,
            metadata: { type: 'kafka_topic', topic: m[1], registry: path.basename(f) },
          });
        }
      }
    }

    const codeFiles = await globFiles(
      ['**/*.{php,js,ts,java,py,go}'],
      { cwd: subproject.root, absolute: true, ignore: ['**/vendor/**'] }
    );
    const seenTopics = new Set(surfaces.map((s) => s.symbol));

    for (const f of capFiles(codeFiles, 'kafka-topic')) {
      const content = fs.readFileSync(f, 'utf-8');
      const topicPatterns = [
        /['"]([\w.-]+\.(created|updated|deleted|event|command|query))['"]/gi,
        /topic\s*=\s*['"]([\w.-]+)['"]/gi,
        /KAFKA_TOPIC\s*=\s*['"]([\w.-]+)['"]/gi,
        /@KafkaListener\s*\([^)]*topic\s*=\s*["']([\w.-]+)["']/gi,
        /->topic\(['"]([\w.-]+)['"]\)/gi,
      ];
      for (const pat of topicPatterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          const topicName = m[1];
          const sym = `kafka:${topicName}`;
          if (!seenTopics.has(sym)) {
            seenTopics.add(sym);
            surfaces.push({
              path: path.relative(subproject.root, f),
              symbol: sym,
              kind: 'event',
              lang: subproject.language,
              startLine: content.slice(0, m.index).split('\n').length,
              metadata: { type: 'kafka_topic_reference', topic: topicName },
            });
          }
        }
      }
    }

    return surfaces;
  }
}
