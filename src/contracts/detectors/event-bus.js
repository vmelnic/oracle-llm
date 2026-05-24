import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class EventBusDetector {
  async detect(subproject) {
    const surfaces = [];
    const codeFiles = await fg(
      ['**/*.{php,js,ts,java,py,go,dart}'],
      { cwd: subproject.root, absolute: true, ignore: ['node_modules/**', 'vendor/**'] }
    );

    const seenEvents = new Map();

    for (const f of codeFiles.slice(0, 500)) {
      const content = fs.readFileSync(f, 'utf-8');

      const eventPatterns = [
        { pat: /dispatch\s*\(\s*new\s+(\w+Event)/gi, framework: 'symfony' },
        { pat: /event(?:Dispatcher|Bus)\s*(?:->|\.)(?:dispatch|fire|emit)\s*\(\s*(?:new\s+)?(\w+)/gi, framework: 'generic' },
        { pat: /event\(\s*['"](\w+)['"]\s*,/gi, framework: 'laravel' },
        { pat: /Event::fire\s*\(\s*['"]([\w.]+)['"]/gi, framework: 'laravel' },
        { pat: /EventEmitter.*emit\s*\(\s*['"]([\w.-]+)['"]/gi, framework: 'node' },
        { pat: /\$emit\s*\(\s*['"]([\w.-]+)['"]/gi, framework: 'vue' },
        { pat: /emit\s*\(\s*['"]([\w.-]+)['"]/gi, framework: 'generic' },
        { pat: /@EventListener|@Subscribe|@KafkaListener|@RabbitListener/gi, framework: 'java-spring' },
        { pat: /publish\s*\(\s*['"]([\w.-]+)['"]/gi, framework: 'pubsub' },
      ];

      for (const { pat, framework } of eventPatterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          const eventName = m[1];
          if (!seenEvents.has(eventName)) {
            seenEvents.set(eventName, {
              path: path.relative(subproject.root, f),
              symbol: `event:${eventName}`,
              kind: 'event',
              lang: subproject.language,
              startLine: content.slice(0, m.index).split('\n').length,
              metadata: { type: 'event_bus_event', name: eventName, framework },
            });
          }
        }
      }
    }

    for (const surface of seenEvents.values()) {
      surfaces.push(surface);
    }
    return surfaces;
  }
}
