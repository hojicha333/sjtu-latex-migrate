import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import { createDesktopPrompt, migrate } from './migrate.mjs';

const fixture = Buffer.from('UEsDBBQAAAAAALqadF02ZYwxOwAAADsAAAAIAAAAbWFpbi50ZXhcZG9jdW1lbnRjbGFzc3thcnRpY2xlfQpcYmVnaW57ZG9jdW1lbnR9VGVzdFxlbmR7ZG9jdW1lbnR9ClBLAQIUABQAAAAAALqadF02ZYwxOwAAADsAAAAIAAAAAAAAAAAAAACAAQAAAABtYWluLnRleFBLBQYAAAAAAQABADYAAABhAAAAAAA=', 'base64');
const name = '迁移样例 (Copy)';
const originalId = '1'.repeat(24);
const targetId = '2'.repeat(24);
const duplicateId = '3'.repeat(24);
const clashId = '4'.repeat(24);
let imports = 0;
let downloads = 0;
let importedName = '';

const row = (id, title, download = false) => `<tr><td><a href="/project/${id}">${title}</a></td>${download ? `<td><button aria-label="下载 ZIP 格式文件" onclick="location.href='/download'">ZIP</button></td>` : ''}</tr>`;
function sendPage(response, html) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
}

async function serve(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/project` };
}

const old = await serve((request, response) => {
  if (request.url === '/download') {
    downloads++;
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename=project.zip' }).end(fixture);
    return;
  }
  sendPage(response, `<div id="project-list-root"><button>创建新项目</button><button>您的项目</button><table>${row(originalId, name, true)}${row(duplicateId, '同名', true)}</table><p>显示 2 个项目(共 2 个)</p></div>`);
});

const target = await serve(async (request, response) => {
  if (request.url === '/upload') {
    imports++;
    const parts = [];
    for await (const part of request) parts.push(part);
    if (!Buffer.concat(parts).equals(fixture)) { response.writeHead(400).end(); return; }
    importedName = decodeURIComponent(request.headers['x-filename']).slice(0, -4);
    response.end(`/project/${targetId}`);
    return;
  }
  if (request.url === `/project/${targetId}`) { sendPage(response, `<title>${name}</title>`); return; }
  sendPage(response, `<div id="project-list-root"><button onclick="document.querySelector('[role=menu]').hidden=false">创建新项目</button><table>${row(clashId, '同名')}${importedName ? row(targetId, importedName) : ''}</table></div>
    <div role="menu" hidden><div role="menuitem" onclick="document.querySelector('dialog').showModal()">现有项目（.zip）</div></div>
    <dialog><button onclick="document.querySelector('input').click()">Select a .zip file</button><input type=file hidden onchange="fetch('/upload',{method:'POST',headers:{'x-filename':encodeURIComponent(this.files[0].name)},body:this.files[0]}).then(r=>r.text()).then(path=>location.href=path)"></dialog>`);
});

const data = await mkdtemp(join(tmpdir(), 'sjtu-latex-desktop-test-'));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await writeFile(join(data, `${name}.zip`), fixture);

  async function run(pick, zipFolder) {
    const context = await browser.newContext({ acceptDownloads: true });
    const input = new PassThrough();
    const prompt = createDesktopPrompt(input, line => {
      const message = JSON.parse(line.slice('@@SJTU_UI@@'.length));
      assert.equal(message.kind, 'projects');
      assert.deepEqual(message.names, [name, '同名']);
      input.write(`${JSON.stringify({ reply: pick })}\n`);
    }, () => { void context.close(); });
    try {
      return await migrate(context, prompt, data, { project: [], 'zip-dir': zipFolder }, old.url, target.url);
    } finally {
      prompt.close();
      input.destroy();
      await context.close();
    }
  }

  assert.equal(await run([0, 1], data), 1);
  assert.equal(await run([0]), 0);
  assert.equal(importedName, name);
  assert.equal(imports, 1);
  assert.equal(downloads, 0);
  const state = JSON.parse(await readFile(join(data, 'migration.json'), 'utf8'));
  assert.equal(state.projects[originalId].targetId, targetId);
  assert.equal(state.projects[originalId].status, 'imported');

  const input = new PassThrough();
  let canceled = false;
  const prompt = createDesktopPrompt(input, line => {
    assert.match(line, /登录完成/);
    input.write('{"cancel":true}\n');
  }, () => { canceled = true; });
  await assert.rejects(prompt.question('登录后按 Enter。'), /迁移已停止/);
  assert.equal(canceled, true);
  prompt.close();
  input.destroy();
} finally {
  await browser?.close();
  old.server.close();
  target.server.close();
  await rm(data, { recursive: true, force: true });
}
