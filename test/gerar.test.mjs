import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validar, formatar, htmlPagina, listarVersoes } from '../gerar.mjs';

const exemplo = JSON.parse(await readFile(new URL('../curriculo.json', import.meta.url), 'utf8'));

test('o exemplo é válido', () => {
  assert.deepEqual(validar(exemplo), []);
});

test('aponta erros em português', () => {
  const erros = validar({ pessoa: {}, versoes: { a: 'A' }, secoes: [{ titulo: 'X', versoes: ['b'], itens: [{}] }] });
  assert.ok(erros.some((e) => e.includes('pessoa.nome')));
  assert.ok(erros.some((e) => e.includes('a versão "b" não existe')));
  assert.ok(erros.some((e) => e.includes('itens[0]: falta "titulo"')));
});

test('formatação: grifo, negrito, link e escape de HTML', () => {
  assert.equal(formatar('==a== **b** <i>'), '<mark>a</mark> <strong>b</strong> &lt;i&gt;');
  assert.equal(formatar('[site](https://x.com)'), '<a href="https://x.com">site</a>');
  assert.equal(formatar('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('cada versão mostra só os seus itens', () => {
  const versoes = listarVersoes(exemplo);
  const docencia = htmlPagina(exemplo, versoes.find((v) => v.chave === 'docencia'), versoes, true);
  const dados = htmlPagina(exemplo, versoes.find((v) => v.chave === 'dados'), versoes, true);
  assert.ok(docencia.includes('A União Faz a Vida'));
  assert.ok(!dados.includes('A União Faz a Vida'));
  assert.ok(dados.includes('Engenheira de dados trainee'));
  assert.ok(!docencia.includes('Engenheira de dados trainee'));
});
