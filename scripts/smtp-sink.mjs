// Local SMTP sink for tests that need to read an email the host API sends (QC-800 password links).
// Accepts every message on 127.0.0.1:<port> and writes it to reports/local/mail/<time>-<n>.eml.
// Nothing is relayed. AUTH is accepted without checking and credentials are never written.
//
//   node scripts/smtp-sink.mjs [port]        (default 2525)
//
// Point the host API at it by setting app.EnvironmentSetting EmailSettings:MailServer = 127.0.0.1 and
// MailPort = <port> (UseSsl false), then restart the API. Restore both values afterwards.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 2525);
const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'reports', 'local', 'mail');
fs.mkdirSync(outDir, { recursive: true });

let counter = 0;

const server = net.createServer(socket => {
  let buffer = '';
  let inData = false;
  let data = [];
  let awaitingAuthLines = 0;
  const reply = line => socket.write(line + '\r\n');

  reply('220 qc-smtp-sink ready');

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          const file = path.join(outDir, `${Date.now()}-${++counter}.eml`);
          fs.writeFileSync(file, data.join('\r\n'));
          data = [];
          reply('250 OK stored');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }

      if (awaitingAuthLines > 0) {
        awaitingAuthLines--;
        reply(awaitingAuthLines > 0 ? '334 UGFzc3dvcmQ6' : '235 Authentication successful');
        continue;
      }

      const verb = line.split(' ')[0].toUpperCase();
      switch (verb) {
        case 'EHLO':
          reply('250-qc-smtp-sink');
          reply('250-AUTH LOGIN PLAIN');
          reply('250 8BITMIME');
          break;
        case 'HELO':
          reply('250 qc-smtp-sink');
          break;
        case 'AUTH': {
          const parts = line.split(' ');
          if (parts[1]?.toUpperCase() === 'LOGIN') {
            awaitingAuthLines = parts.length > 2 ? 1 : 2;
            reply(parts.length > 2 ? '334 UGFzc3dvcmQ6' : '334 VXNlcm5hbWU6');
          } else {
            reply(parts.length > 2 ? '235 Authentication successful' : '334 ');
            if (parts.length <= 2) awaitingAuthLines = 1;
          }
          break;
        }
        case 'DATA':
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          break;
        case 'QUIT':
          reply('221 Bye');
          socket.end();
          break;
        default:
          reply('250 OK');
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => console.log(`smtp-sink listening on 127.0.0.1:${port}, writing to ${outDir}`));
