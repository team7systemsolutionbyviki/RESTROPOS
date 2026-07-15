const http = require('http');
const net = require('net');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9100;

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const printer = data.printer;
        const content = data.content;

        if (!printer || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing printer or content' }));
          return;
        }

        console.log(`Received print request for printer: "${printer}"`);

        // Check if printer is an IP Address
        const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(printer.split(':')[0]);

        if (isIp) {
          // ─── Network TCP/IP ESC/POS Printer ───
          const host = printer.split(':')[0];
          const port = parseInt(printer.split(':')[1]) || 9100;

          // Strip HTML tags for clean raw text formatting
          const cleanText = content
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/tr>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<[^>]+>/g, '') // Strip remaining HTML tags
            .replace(/\n\s*\n/g, '\n'); // Strip duplicate newlines

          console.log(`Sending print job to IP printer ${host}:${port}...`);
          const socket = net.connect({ host, port }, () => {
            // Write clean text to network printer
            socket.write(cleanText + '\n\n\n\n\n\x1bi\n'); // Feed and paper cut command
            socket.end();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Sent to network IP printer.' }));
          });

          socket.on('error', (err) => {
            console.error('Socket connection error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Connection failed: ${err.message}` }));
          });
        } else {
          // ─── Local USB/System Printer (Windows) ───
          const tempFile = path.join(__dirname, 'temp_print.txt');
          const cleanText = content
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/tr>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\n\s*\n/g, '\n');

          fs.writeFileSync(tempFile, cleanText, 'utf-8');

          // Trigger PowerShell command to print text file directly to target printer name
          const cmd = `powershell -Command "Get-Content '${tempFile}' | Out-Printer -Name '${printer}'"`;
          console.log(`Executing print shell command: ${cmd}`);

          exec(cmd, (error, stdout, stderr) => {
            // Clean up temp file
            try { fs.unlinkSync(tempFile); } catch(e){}

            if (error) {
              console.error('PowerShell print error:', stderr || error.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Failed to print to local printer: ${stderr || error.message}` }));
            } else {
              console.log('Successfully printed to local printer:', printer);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Sent to local system printer: ${printer}` }));
            }
          });
        }
      } catch (err) {
        console.error('Request parsing/processing error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Internal Server Error: ${err.message}` }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 RestoPOS Printer Helper Daemon is running on Port ${PORT}`);
  console.log(`🔌 Route KOT / Receipt IP addresses or USB printer names`);
  console.log(`======================================================\n`);
});
