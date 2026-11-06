#!/usr/bin/env node
// Gerador de currículo: lê um arquivo JSON e gera uma página web e um PDF
// para cada versão do currículo (por exemplo: completo, docência, dados).
//
// Uso:
//   node gerar.mjs [curriculo.json] [--saida pasta] [--sem-pdf] [--versao chave]

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));

// ---------- Linha de comando ----------

function lerArgumentos(argv) {
  const opcoes = { entrada: 'curriculo.json', saida: 'saida', pdf: true, versao: null, assistir: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--saida' || a === '-o') opcoes.saida = argv[++i];
    else if (a === '--sem-pdf') opcoes.pdf = false;
    else if (a === '--versao' || a === '-v') opcoes.versao = argv[++i];
    else if (a === '--assistir' || a === '-w') opcoes.assistir = true;
    else if (a === '--ajuda' || a === '-h') opcoes.ajuda = true;
    else if (!a.startsWith('-')) opcoes.entrada = a;
    else throw new Error(`Opção desconhecida: ${a}. Use --ajuda para ver as opções.`);
  }
  return opcoes;
}

const AJUDA = `
Gerador de currículo em JSON

  node gerar.mjs [arquivo.json] [opções]

Opções:
  -o, --saida PASTA   pasta onde os arquivos são gravados (padrão: saida)
  -v, --versao CHAVE  gera só uma versão (por exemplo: docencia)
      --sem-pdf       gera só as páginas web, sem PDF
  -w, --assistir      gera de novo sempre que o JSON for salvo
  -h, --ajuda         mostra esta ajuda
`;

// ---------- Validação ----------

function validar(cv) {
  const erros = [];
  const ehTexto = (v) => typeof v === 'string' && v.trim() !== '';
  const ehLista = Array.isArray;

  if (!cv || typeof cv !== 'object') return ['O arquivo precisa ser um objeto JSON: { ... }'];
  if (!cv.pessoa || !ehTexto(cv.pessoa.nome)) erros.push('Falta "pessoa.nome".');

  const chaves = cv.versoes ? Object.keys(cv.versoes) : [];
  if (cv.versoes && (typeof cv.versoes !== 'object' || chaves.length === 0)) {
    erros.push('"versoes" precisa ser um objeto como { "completo": "Completo" }.');
  }
  const conferirVersoes = (obj, onde) => {
    if (obj.versoes === undefined) return;
    if (!ehLista(obj.versoes)) return erros.push(`${onde}: "versoes" precisa ser uma lista, como ["completo"].`);
    for (const v of obj.versoes) {
      if (!chaves.includes(v)) erros.push(`${onde}: a versão "${v}" não existe em "versoes" (${chaves.join(', ') || 'nenhuma definida'}).`);
    }
  };

  if (cv.resumo !== undefined && typeof cv.resumo !== 'string' && typeof cv.resumo !== 'object') {
    erros.push('"resumo" precisa ser um texto ou um objeto com um texto por versão.');
  }
  (cv.pessoa?.contatos ?? []).forEach((c, i) => {
    if (!ehTexto(c.texto)) erros.push(`pessoa.contatos[${i}]: falta "texto".`);
  });

  if (cv.secoes !== undefined && !ehLista(cv.secoes)) erros.push('"secoes" precisa ser uma lista.');
  (cv.secoes ?? []).forEach((s, i) => {
    const onde = `secoes[${i}]${s.titulo ? ` ("${s.titulo}")` : ''}`;
    if (!ehTexto(s.titulo)) erros.push(`${onde}: falta "titulo".`);
    conferirVersoes(s, onde);
    const tipo = s.tipo ?? 'itens';
    if (!['itens', 'lista', 'pilulas', 'texto'].includes(tipo)) {
      erros.push(`${onde}: tipo "${tipo}" não existe. Use itens, lista, pilulas ou texto.`);
    } else if (tipo === 'texto') {
      if (!ehTexto(s.texto)) erros.push(`${onde}: seções do tipo "texto" precisam de "texto".`);
    } else if (tipo === 'pilulas') {
      if (!ehLista(s.grupos)) erros.push(`${onde}: seções do tipo "pilulas" precisam de "grupos".`);
      (s.grupos ?? []).forEach((g, j) => {
        conferirVersoes(g, `${onde} > grupos[${j}]`);
        if (!ehLista(g.itens)) erros.push(`${onde} > grupos[${j}]: falta a lista "itens".`);
      });
    } else {
      if (!ehLista(s.itens)) erros.push(`${onde}: falta a lista "itens".`);
      (s.itens ?? []).forEach((it, j) => {
        const ondeItem = `${onde} > itens[${j}]`;
        if (!ehTexto(it.titulo)) erros.push(`${ondeItem}: falta "titulo".`);
        conferirVersoes(it, ondeItem);
        if (it.topicos !== undefined && !ehLista(it.topicos)) erros.push(`${ondeItem}: "topicos" precisa ser uma lista.`);
        if (it.tags !== undefined && !ehLista(it.tags)) erros.push(`${ondeItem}: "tags" precisa ser uma lista.`);
      });
    }
  });
  return erros;
}

// ---------- Texto ----------

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const linkSeguro = (url) => /^(https?:|mailto:|tel:)/i.test(url) ? url : null;

// Formatação simples dentro dos textos: **negrito**, ==grifo== e [texto](link)
function formatar(texto) {
  return esc(texto)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (tudo, rotulo, url) => {
      const seguro = linkSeguro(url.replace(/&amp;/g, '&'));
      return seguro ? `<a href="${esc(seguro)}">${rotulo}</a>` : tudo;
    });
}

const textoPuro = (t) => String(t ?? '').replace(/\*\*|==/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- Versões ----------

function listarVersoes(cv) {
  const v = cv.versoes && Object.keys(cv.versoes).length ? cv.versoes : { completo: 'Completo' };
  return Object.entries(v).map(([chave, rotulo], i) => ({
    chave, rotulo,
    pagina: i === 0 ? 'index.html' : `${chave}.html`,
    pdf: `${slug(cv.pessoa.nome)}-${chave}.pdf`,
  }));
}

const entra = (obj, chave) => !obj.versoes || obj.versoes.includes(chave);

function resumoDa(cv, chave) {
  if (!cv.resumo) return '';
  if (typeof cv.resumo === 'string') return cv.resumo;
  return cv.resumo[chave] ?? cv.resumo.padrao ?? Object.values(cv.resumo)[0] ?? '';
}

// ---------- HTML ----------

function linkOuTexto(texto, url, classe = '') {
  const seguro = url && linkSeguro(url);
  const c = classe ? ` class="${classe}"` : '';
  return seguro ? `<a${c} href="${esc(seguro)}">${esc(texto)}</a>` : `<span${c}>${esc(texto)}</span>`;
}

function htmlItem(it) {
  const tituloHtml = it.link && linkSeguro(it.link)
    ? `<a href="${esc(it.link)}">${esc(it.titulo)}<span class="seta" aria-hidden="true"> ↗</span></a>`
    : esc(it.titulo);
  return `
      <article class="item">
        <header class="item-topo">
          <h3>${tituloHtml}</h3>
          ${it.periodo ? `<p class="periodo">${esc(it.periodo)}</p>` : ''}
        </header>
        ${it.local ? `<p class="local">${formatar(it.local)}</p>` : ''}
        ${it.texto ? `<p>${formatar(it.texto)}</p>` : ''}
        ${it.topicos?.length ? `<ul class="topicos">${it.topicos.map((t) => `<li>${formatar(t)}</li>`).join('')}</ul>` : ''}
        ${it.tags?.length ? `<ul class="tags" aria-label="Ferramentas">${it.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </article>`;
}

function htmlSecao(s, chave) {
  const tipo = s.tipo ?? 'itens';
  const id = slug(s.titulo);
  let corpo = '';
  if (tipo === 'texto') {
    corpo = `<p>${formatar(s.texto)}</p>`;
  } else if (tipo === 'pilulas') {
    const grupos = s.grupos.filter((g) => entra(g, chave));
    if (!grupos.length) return '';
    corpo = grupos.map((g) => `
      <div class="grupo">
        ${g.titulo ? `<h3>${esc(g.titulo)}</h3>` : ''}
        <ul class="pilulas">${g.itens.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`).join('');
  } else if (tipo === 'lista') {
    const itens = s.itens.filter((it) => entra(it, chave));
    if (!itens.length) return '';
    corpo = `<ul class="lista">${itens.map((it) => `
        <li>
          <span class="lista-texto"><strong>${it.link ? linkOuTexto(it.titulo, it.link) : esc(it.titulo)}</strong>${it.local ? ` · ${formatar(it.local)}` : ''}</span>
          ${it.periodo ? `<span class="periodo">${esc(it.periodo)}</span>` : ''}
        </li>`).join('')}
      </ul>`;
  } else {
    const itens = s.itens.filter((it) => entra(it, chave));
    if (!itens.length) return '';
    corpo = itens.map(htmlItem).join('');
  }
  return `
    <section class="secao secao-${tipo}" aria-labelledby="${id}">
      <h2 id="${id}">${esc(s.titulo)}</h2>
      ${corpo}
    </section>`;
}

function htmlPagina(cv, versao, versoes, comPdf) {
  const p = cv.pessoa;
  const resumo = resumoDa(cv, versao.chave);
  const secoes = (cv.secoes ?? []).filter((s) => entra(s, versao.chave)).map((s) => htmlSecao(s, versao.chave)).join('');
  const rodape = cv.rodape ?? {};
  const descricao = textoPuro(resumo).slice(0, 200);
  const tituloPagina = versoes.length > 1 ? `${p.nome} · Currículo (${versao.rotulo})` : `${p.nome} · Currículo`;

  const menuVersoes = versoes.length > 1 ? `
      <nav class="versoes" aria-label="Versão do currículo">
        ${versoes.map((v) => `<a href="${v.pagina}"${v.chave === versao.chave ? ' aria-current="page"' : ''}>${esc(v.rotulo)}</a>`).join('')}
      </nav>` : '<span></span>';

  const botaoPdf = comPdf
    ? `<a class="botao" href="${versao.pdf}" download>Baixar PDF</a>`
    : `<button class="botao" type="button" onclick="window.print()">Salvar em PDF</button>`;

  return `<!DOCTYPE html>
<html lang="${esc(cv.idioma ?? 'pt-BR')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tituloPagina)}</title>
<meta name="description" content="${esc(descricao)}">
<meta name="author" content="${esc(p.nome)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(tituloPagina)}">
<meta property="og:description" content="${esc(descricao)}">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="assets/estilo.css">
</head>
<body>
<a class="pular" href="#conteudo">Pular para o currículo</a>
<div class="barra">
  <div class="barra-dentro">
    ${menuVersoes}
    ${botaoPdf}
  </div>
</div>

<main id="conteudo" class="janela">
  <div class="janela-topo" aria-hidden="true">
    <span class="bolinhas"><i></i><i></i><i></i></span>
    <span class="janela-nome">${esc(versao.pagina === 'index.html' ? 'curriculo.html' : `curriculo-${versao.chave}.html`)}</span>
  </div>

  <div class="janela-corpo">
    <header class="cabecalho">
      ${p.foto ? `<img class="foto" src="${esc(p.foto)}" alt="" width="112" height="112">` : ''}
      <div>
        <h1>${esc(p.nome)}</h1>
        ${p.titulo ? `<p class="titulo">${formatar(p.titulo)}</p>` : ''}
        ${p.subtitulo ? `<p class="subtitulo">${formatar(p.subtitulo)}</p>` : ''}
      </div>
    </header>

    ${p.contatos?.length ? `
    <ul class="contatos">
      ${p.contatos.map((c) => `<li>${c.rotulo ? `<span class="rotulo">${esc(c.rotulo)}</span>` : ''}${linkOuTexto(c.texto, c.link)}</li>`).join('\n      ')}
    </ul>` : ''}

    ${resumo ? `
    <section class="secao resumo" aria-label="Resumo">
      <p>${formatar(resumo)}</p>
    </section>` : ''}
    ${secoes}
  </div>
</main>

<footer class="rodape">
  <span class="rodape-nome">${esc(p.nome)}</span>
  ${rodape.site ? linkOuTexto(rodape.site, rodape.link, 'pilula-site') : ''}
</footer>
</body>
</html>
`;
}

// ---------- PDF ----------

async function carregarPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      // Playwright instalado globalmente (fora do projeto)
      return createRequire(path.join(process.cwd(), 'x.js'))('playwright');
    } catch {
      return null;
    }
  }
}

async function gerarPdfs(pastaSaida, cv, versoes) {
  const pw = await carregarPlaywright();
  if (!pw) {
    console.warn('\n⚠  Playwright não está instalado, então os PDFs não foram gerados.');
    console.warn('   Rode "npm install" e "npx playwright install chromium", ou use --sem-pdf.');
    return false;
  }
  const navegador = await pw.chromium.launch();
  const pagina = await navegador.newPage();
  await pagina.emulateMedia({ media: 'print', colorScheme: 'light' });
  const rodape = `
    <div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7.5pt;color:#6f6f6f;
                padding:0 14mm;display:flex;justify-content:space-between;">
      <span>${esc(cv.pessoa.nome)}${cv.rodape?.site ? ` · ${esc(cv.rodape.site)}` : ''}</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`;
  for (const v of versoes) {
    await pagina.goto(pathToFileURL(path.join(pastaSaida, v.pagina)).href, { waitUntil: 'load' });
    await pagina.evaluate(() => document.fonts.ready);
    await pagina.pdf({
      path: path.join(pastaSaida, v.pdf),
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: rodape,
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    console.log(`  ✓ ${path.join(pastaSaida, v.pdf)}`);
  }
  await navegador.close();
  return true;
}

// ---------- Principal ----------

async function gerar(opcoes) {
  const bruto = await readFile(opcoes.entrada, 'utf8');
  let cv;
  try {
    cv = JSON.parse(bruto);
  } catch (e) {
    throw new Error(`O arquivo ${opcoes.entrada} não é um JSON válido: ${e.message}`);
  }
  const erros = validar(cv);
  if (erros.length) {
    throw new Error(`Encontrei ${erros.length} problema(s) em ${opcoes.entrada}:\n  • ${erros.join('\n  • ')}`);
  }

  let versoes = listarVersoes(cv);
  if (opcoes.versao) {
    if (!versoes.some((v) => v.chave === opcoes.versao)) {
      throw new Error(`A versão "${opcoes.versao}" não existe. Versões: ${versoes.map((v) => v.chave).join(', ')}.`);
    }
  }

  const saida = path.resolve(opcoes.saida);
  await mkdir(path.join(saida, 'assets'), { recursive: true });
  await cp(path.join(RAIZ, 'modelo', 'estilo.css'), path.join(saida, 'assets', 'estilo.css'));
  await cp(path.join(RAIZ, 'modelo', 'fontes'), path.join(saida, 'assets', 'fontes'), { recursive: true });

  // Foto local: copia para a pasta de saída
  if (cv.pessoa.foto && !/^https?:/i.test(cv.pessoa.foto)) {
    const origem = path.resolve(path.dirname(opcoes.entrada), cv.pessoa.foto);
    if (existsSync(origem)) {
      const destino = `assets/${path.basename(origem)}`;
      await cp(origem, path.join(saida, destino));
      cv.pessoa.foto = destino;
    } else {
      console.warn(`⚠  Foto não encontrada: ${origem}`);
      delete cv.pessoa.foto;
    }
  }

  const escolhidas = opcoes.versao ? versoes.filter((v) => v.chave === opcoes.versao) : versoes;
  console.log(`Gerando ${escolhidas.length} versão(ões) em ${saida}`);
  for (const v of escolhidas) {
    await writeFile(path.join(saida, v.pagina), htmlPagina(cv, v, versoes, opcoes.pdf));
    console.log(`  ✓ ${path.join(saida, v.pagina)}`);
  }

  if (opcoes.pdf) {
    const ok = await gerarPdfs(saida, cv, escolhidas);
    if (!ok) {
      // Sem PDF: refaz as páginas com o botão "Salvar em PDF" do navegador
      for (const v of escolhidas) await writeFile(path.join(saida, v.pagina), htmlPagina(cv, v, versoes, false));
    }
  }
  console.log('Pronto.');
}

const executadoDireto = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const opcoes = executadoDireto ? lerArgumentos(process.argv.slice(2)) : null;
if (!executadoDireto) {
  // importado como módulo (testes): não roda nada
} else if (opcoes.ajuda) {
  console.log(AJUDA);
} else {
  try {
    await gerar(opcoes);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    if (!opcoes.assistir) process.exit(1);
  }
  if (opcoes.assistir) {
    console.log(`\nAssistindo ${opcoes.entrada}. Salve o arquivo para gerar de novo (Ctrl+C para sair).`);
    let espera;
    watch(opcoes.entrada, () => {
      clearTimeout(espera);
      espera = setTimeout(() => gerar(opcoes).catch((e) => console.error(`\n✗ ${e.message}`)), 150);
    });
  }
}

export { validar, formatar, htmlPagina, listarVersoes };
