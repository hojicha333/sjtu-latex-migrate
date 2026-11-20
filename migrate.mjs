import { copyFile, open, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as createTerminalInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const sourceUrl = 'https://latex.sjtu.edu.cn/project';
const targetUrl = 'https://latexpro.sjtu.edu.cn/project';
const listRoot = '#project-list-root';
const projectLinks = 'table a[href^="/project/"]';
const newProject = /^(创建(一个)?新项目|New Project|Create a new project)$/i;
const ownedProjects = /^(您的项目|Your Projects)$/i;
const zipDownload = /^(下载\s*ZIP\s*格式文件|Download (as )?(a )?(ZIP|Source)( file)?)$/i;
const zipImport = /^(现有项目\s*[（(]\.zip[）)]|Upload Project|Existing project\s*\(\.zip\))$/i;
const uploadTimeout = 180_000;

function projectId(url, listUrl) {
  const address = new URL(url, listUrl);
  if (address.origin !== new URL(listUrl).origin) return null;
  return /^\/project\/([a-f0-9]{24})\/?$/i.exec(address.pathname)?.[1] ?? null;
}

async function readProjects(page, listUrl) {
  const projects = await page.locator(projectLinks).evaluateAll(links => links.map(link => ({
    url: link.href,
    name: link.innerText.trim(),
  })));
  const result = projects.map(project => ({ ...project, id: projectId(project.url, listUrl) }));
  if (result.some(project => !project.id || !project.name)) {
    throw new Error('项目列表格式有变化，已停止。');
  }
  const counts = await page.locator(listRoot).getByText(/显示\s*\d+\s*个项目|showing\s+.*projects?/i).allTextContents();
  const count = counts.map(text => /(?:共|\bof)\s*([\d,]+)/i.exec(text)?.[1]).find(Boolean);
  if (count && Number(count.replaceAll(',', '')) !== result.length) {
    throw new Error('当前页面没有显示完整的项目列表，请核对筛选或分页后再试。');
  }
  return result;
}

async function waitForList(page, url) {
  await page.locator(listRoot).getByRole('button', { name: newProject }).waitFor({ timeout: 12_000 });
  if (page.url().replace(/\/$/, '') !== url) throw new Error('请打开预期的项目列表。');
}

async function signIn(page, url, prompt) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await waitForList(page, url);
  } catch {
    await page.bringToFront();
    await prompt.question(`请在工具打开的 Edge 中完成 ${new URL(url).hostname} 的 jAccount 登录，看到项目列表后按 Enter。`);
    await waitForList(page, url);
  }
}

function zipName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!cleaned || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned) || cleaned.length > 180) {
    throw new Error(`项目名无法作为本地 ZIP 文件名，请在网页上手动迁移：${name}`);
  }
  if (cleaned !== name) throw new Error(`该项目名需要手动迁移才能保留原名：${name}`);
  return `${cleaned}.zip`;
}

async function zipHash(path) {
  const file = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    await file.read(magic);
    if (!magic.equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new Error('下载结果不是包含文件的 ZIP。');
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exportZip(page, project, archive) {
  const row = page.getByRole('row').filter({ has: page.locator(`a[href="/project/${project.id}"]`) });
  const button = row.getByRole('button', { name: zipDownload });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    button.click(),
  ]);
  const temporaryPath = `${archive}.partial`;
  await download.saveAs(temporaryPath);
  const sha256 = await zipHash(temporaryPath);
  await rename(temporaryPath, archive);
  return sha256;
}

export async function importZip(page, reader, archive, project, listUrl) {
  const root = page.locator(listRoot);
  await root.getByRole('button', { name: newProject }).click();
  await page.getByRole('menuitem', { name: zipImport }).click();
  const modal = page.getByRole('dialog');
  const select = modal.getByRole('button', { name: /^(Select a \.zip file|选择.*\.zip.*)$/i });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), select.click()]);
  await chooser.setFiles(archive);

  const manualUpload = modal.getByRole('button', { name: /^(Upload( 1 file)?|上传( 1 个文件)?)$/i });
  const manualVisible = await manualUpload.waitFor({ timeout: 1_000 }).then(() => true, () => false);
  if (manualVisible && await manualUpload.isEnabled()) await manualUpload.click();

  // Uppy normally redirects to the editor. Some versions update the list instead.
  const row = page.locator(projectLinks).and(page.getByRole('link', { name: project.name, exact: true }));
  const editor = page.waitForURL(url => Boolean(projectId(url, listUrl)), { timeout: uploadTimeout }).then(() => page.url());
  const updatedList = row.waitFor({ timeout: uploadTimeout }).then(() => null);
  const errorNotice = modal.locator('.uppy-Informer').getByText(/failed|error|too large|失败|错误|过大/i).first();
  const failure = errorNotice.waitFor({ timeout: uploadTimeout }).then(async () => {
    throw new Error(await errorNotice.innerText());
  });
  const editorUrl = await Promise.race([editor, updatedList, failure]);

  await reader.reload({ waitUntil: 'domcontentloaded' });
  await waitForList(reader, listUrl);
  const matches = (await readProjects(reader, listUrl)).filter(item => item.name === project.name);
  const expectedId = editorUrl && projectId(editorUrl, listUrl);
  const verified = expectedId ? matches.find(item => item.id === expectedId) : matches.length === 1 && matches[0];
  if (!verified) throw new Error('新站列表未能确认导入结果。请先在新站核对，再继续。');
  return verified;
}

async function readState(path, from, to) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || state.source !== from || state.target !== to || !state.projects) {
      throw new Error('迁移记录与当前站点不匹配。');
    }
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, source: from, target: to, projects: {} };
  }
}

function saveState(path, state) {
  const temporaryPath = `${path}.tmp`;
  return writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flush: true })
    .then(() => rename(temporaryPath, path));
}

export async function migrate(context, prompt, folder, options, from = sourceUrl, to = targetUrl) {
  const old = context.pages()[0] ?? await context.newPage();
  await signIn(old, from, prompt);
  const owned = old.locator(listRoot).getByRole('button', { name: ownedProjects });
  if (await owned.count()) {
    await owned.click();
  } else if (await old.locator(projectLinks).count()) {
    throw new Error('找不到旧站的「您的项目」筛选，无法核对项目拥有者。');
  }
  const sources = await readProjects(old, from);
  const picked = prompt.selectProjects ? await prompt.selectProjects(sources.map(project => project.name)) : null;
  const selected = picked === null
    ? (options.project.length ? sources.filter(p => options.project.includes(p.name)) : sources)
    : sources.filter((_, index) => picked.includes(index));
  const missing = options.project.filter(name => !selected.some(p => p.name === name));
  if (missing.length) throw new Error(`找不到项目：${missing.join('、')}`);
  console.log(`旧站自己的项目，共 ${selected.length} 个：`);
  for (const project of selected) console.log(`  ${project.name}`);
  if (options.list || !selected.length) return 0;

  const reader = await context.newPage();
  await signIn(reader, to, prompt);
  const uploader = await context.newPage();
  const statePath = join(folder, 'migration.json');
  const state = await readState(statePath, from, to);
  const duplicates = selected.filter(p => sources.filter(other => other.name === p.name).length > 1);
  if (duplicates.length) console.log('旧站同名项目需要在网页上手动迁移。');

  if (!options.yes && picked === null) {
    const answer = await prompt.question(`将上述项目的 ZIP 上传到 ${new URL(to).hostname}。输入 y 开始：`);
    if (answer.trim().toLowerCase() !== 'y') return 0;
  }

  let verified = 0;
  for (const [index, project] of selected.entries()) {
    const label = `[${index + 1}/${selected.length}] ${project.name}`;
    if (duplicates.includes(project)) {
      console.log(`${label} — 旧站名称重复，跳过。`);
      continue;
    }
    await reader.reload({ waitUntil: 'domcontentloaded' });
    await waitForList(reader, to);
    const targets = await readProjects(reader, to);
    const byName = targets.filter(item => item.name === project.name);
    const entry = state.projects[project.id];
    if (entry?.status === 'imported') {
      if (targets.some(item => item.id === entry.targetId)) {
        verified++;
        console.log(`${label} — 已导入，跳过。`);
      } else {
        console.log(`${label} — 新站列表找不到记录中的项目，请核对。`);
      }
      continue;
    }
    if (byName.length) {
      console.log(`${label} — 新站已有同名项目，请自行确认，跳过。`);
      continue;
    }
    if (entry?.status === 'uploading' && !options['retry-pending']) {
      console.log(`${label} — 上次上传结果未确认。核对新站后可用 --retry-pending 重试。`);
      continue;
    }

    let archive;
    let sha256;
    try {
      const archiveFolder = join(folder, 'zips', project.id);
      await mkdir(archiveFolder, { recursive: true });
      const filename = zipName(project.name);
      archive = join(archiveFolder, filename);
      const savedHash = entry?.sha256 && await zipHash(archive).catch(() => null);
      if (options['zip-dir']) {
        const suppliedArchive = resolve(options['zip-dir'], filename);
        sha256 = await zipHash(suppliedArchive);
        if (suppliedArchive !== archive) {
          await copyFile(suppliedArchive, `${archive}.partial`);
          if (await zipHash(`${archive}.partial`) !== sha256) throw new Error('本地 ZIP 在复制时发生变化。');
          await rename(`${archive}.partial`, archive);
        }
      } else {
        sha256 = savedHash && savedHash === entry.sha256 ? savedHash : await exportZip(old, project, archive);
      }
    } catch (error) {
      console.error(`${label} — 导出失败：${error.message.split('\n')[0]}`);
      continue;
    }

    state.projects[project.id] = { name: project.name, archive, sha256, status: 'exported' };
    await saveState(statePath, state);
    await uploader.goto(to, { waitUntil: 'domcontentloaded' });
    await waitForList(uploader, to);
    await uploader.bringToFront();
    state.projects[project.id].status = 'uploading';
    await saveState(statePath, state);
    console.log(`${label} — 正在上传…`);
    try {
      const result = await importZip(uploader, reader, archive, project, to);
      Object.assign(state.projects[project.id], { status: 'imported', targetId: result.id, targetUrl: result.url });
      await saveState(statePath, state);
      verified++;
      console.log(`${label} — 已导入 ${result.url}`);
    } catch (error) {
      console.error(`${label} — 上传未确认：${error.message.split('\n')[0]}`);
    }
  }

  console.log(`已核对 ${verified}/${selected.length} 个项目。记录：${statePath}`);
  return verified === selected.length ? 0 : 1;
}

export function createDesktopPrompt(input, write, cancel) {
  const lines = createInterface({ input });
  let reply;
  let canceled = false;
  const stop = () => {
    if (canceled) return;
    canceled = true;
    if (reply) reply.reject(new Error('迁移已停止。'));
    reply = undefined;
    cancel();
  };
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.cancel) {
      stop();
    } else if (reply) {
      const pending = reply;
      reply = undefined;
      pending.resolve(message?.reply);
    }
  });
  lines.on('close', stop);

  const request = message => new Promise((resolveReply, reject) => {
    if (canceled) { reject(new Error('迁移已停止。')); return; }
    reply = { resolve: resolveReply, reject };
    write(`@@SJTU_UI@@${JSON.stringify(message)}`);
  });
  return {
    question: message => request({ kind: 'login', message: message.replace('按 Enter。', '点「登录完成」。') }),
    async selectProjects(names) {
      if (!names.length) return [];
      const selected = await request({ kind: 'projects', names });
      return Array.isArray(selected) ? selected.filter(index => Number.isInteger(index)) : [];
    },
    close() { lines.off('close', stop); lines.close(); },
    get canceled() { return canceled; },
  };
}

async function main() {
  const { values: options } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    list: { type: 'boolean' },
    project: { type: 'string', multiple: true, default: [] },
    yes: { type: 'boolean', short: 'y' },
    'retry-pending': { type: 'boolean' },
    'zip-dir': { type: 'string' },
    'data-dir': { type: 'string' },
    gui: { type: 'boolean' },
  } });
  if (options.help) {
    console.log('Start-Migration.cmd [--list] [--project "项目名"] [--zip-dir "ZIP 目录"] [--yes] [--retry-pending] [--data-dir "路径"]');
    return 0;
  }

  const folder = resolve(options['data-dir'] ?? join(process.env.LOCALAPPDATA ?? homedir(), 'SJTU-LaTeX-Migration'));
  await mkdir(folder, { recursive: true });
  const lockPath = join(folder, 'running.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error(`迁移工具正在使用这个目录。若确认上次已退出，可移除 ${lockPath} 后再运行。`);
    throw error;
  });

  let context;
  const desktop = options.gui && createDesktopPrompt(process.stdin, console.log, () => {
    void context?.close().catch(() => {});
  });
  const prompt = desktop || createTerminalInterface({ input: process.stdin, output: process.stdout });
  try {
    context = await chromium.launchPersistentContext(join(folder, 'edge-profile'), {
      channel: 'msedge', headless: false, acceptDownloads: true, viewport: null,
    });
    if (desktop?.canceled) throw new Error('迁移已停止。');
    return await migrate(context, prompt, folder, options);
  } catch (error) {
    if (desktop?.canceled) throw new Error('迁移已停止。');
    throw error;
  } finally {
    prompt.close();
    try {
      await context?.close();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
