/* Robô do km — Guimas Car
   - A cada INTERVALO_DIAS pede, pelo WhatsApp, a foto do painel a cada motorista ativo do Gestão.
   - Lê o hodômetro da foto (Gemini), responde quanto falta para óleo e correia dentada
     e grava a leitura em familias/<h>/robo, que o Gestão importa como última quilometragem.
   - Quem não responde em ALERTA_DIAS aparece no Gestão para o Hudson cobrar pessoalmente.
   Segredos (Cloudflare → Settings → Variables and Secrets): CHAVE, GEMINI_KEY, WA_KEY.
   Nada de segredo neste arquivo: ele é público no GitHub. */

const VERSAO = 'robo-km 1.0';
const DIA = 864e5;

/* ---------------- utilidades ---------------- */
async function sha(txt) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? d : Number(v);
const fmtKm = n => Math.round(n).toLocaleString('pt-BR');
const dataBRT = ts => new Date(ts - 3 * 3600e3).toISOString().slice(0, 10);
const brDate = iso => iso ? iso.split('-').reverse().join('/') : '';
const primeiroNome = n => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : ''; };
function fmtPlaca(p) { p = String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return p.length === 7 ? p.slice(0, 3) + '-' + p.slice(3) : p; }

/* Telefone BR: chave = DDD + 8 últimos dígitos (o WhatsApp às vezes manda sem o 9). */
function foneDigitos(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length >= 10 && d.length <= 11 ? d : '';
}
function foneChave(t) { const d = foneDigitos(t); return d ? d.slice(0, 2) + d.slice(-8) : ''; }
function foneEnvio(t) {
  const d = foneDigitos(t); if (!d) return '';
  /* celular com 8 dígitos após o DDD ganha o 9 */
  return '55' + (d.length === 10 && /[6-9]/.test(d[2]) ? d.slice(0, 2) + '9' + d.slice(2) : d);
}

/* ---------------- contexto (env + Firebase) ---------------- */
class Ctx {
  constructor(env) {
    this.env = env; this.sub = 0; this.tok = null;
    this.db = env.FIREBASE_DB || 'https://guimas-73e01-default-rtdb.firebaseio.com';
    this.intervalo = num(env.INTERVALO_DIAS, 20); this.alerta = num(env.ALERTA_DIAS, 3);
  }
  async init() {
    if (!this.env.CHAVE) throw new Error('Falta o segredo CHAVE');
    this.h = await sha('guimas:' + this.env.CHAVE);
    this.admin = (await sha('admin:' + this.env.CHAVE)).slice(0, 32);
    this.wh = (await sha('wh:' + this.env.CHAVE)).slice(0, 24);
    return this;
  }
  async f(url, opt) { this.sub++; return fetch(url, opt); }
  async token() {
    if (this.tok) return this.tok;
    const g = globalThis.__fbTok;
    if (g && g.exp > Date.now() + 60e3) return (this.tok = g.t);
    const r = await this.f('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + this.env.FIREBASE_API_KEY, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"returnSecureToken":true}'
    });
    const j = await r.json();
    if (!j.idToken) throw new Error('Firebase auth: ' + JSON.stringify(j).slice(0, 200));
    globalThis.__fbTok = { t: j.idToken, exp: Date.now() + (num(j.expiresIn, 3600) - 120) * 1000 };
    return (this.tok = j.idToken);
  }
  async fb(metodo, caminho, corpo) {
    const url = `${this.db}/familias/${this.h}/${caminho}.json?auth=${await this.token()}`;
    const r = await this.f(url, { method: metodo, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    if (!r.ok) throw new Error(`Firebase ${metodo} ${caminho}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  get(c) { return this.fb('GET', c); }
  patch(c, v) { return this.fb('PATCH', c, v); }
  put(c, v) { return this.fb('PUT', c, v); }
  post(c, v) { return this.fb('POST', c, v); }

  /* ---------- WhatsApp (Graph API ou Dualhook, mesmo formato) ---------- */
  get waBase() { return (this.env.WA_BASE || 'https://api.dualhook.com/v25.0').replace(/\/$/, ''); }
  async wa(caminho, corpo) {
    const r = await this.f(`${this.waBase}/${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + this.env.WA_KEY, 'content-type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`WhatsApp ${caminho}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }
  texto(para, body) {
    return this.wa(`${this.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body, preview_url: false } });
  }
  modelo(para, params) {
    return this.wa(`${this.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to: para, type: 'template',
      template: { name: this.env.TEMPLATE_NAME || 'foto_painel_km', language: { code: this.env.TEMPLATE_LANG || 'pt_BR' },
        components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 60) })) }] }
    });
  }
  async baixarMidia(id) {
    const auth = { authorization: 'Bearer ' + this.env.WA_KEY };
    if (/dualhook/.test(this.waBase)) {
      const r = await this.f(`${this.waBase}/${id}/content`, { headers: auth });
      if (!r.ok) throw new Error('mídia ' + r.status);
      return { bytes: await r.arrayBuffer(), mime: r.headers.get('content-type') || 'image/jpeg' };
    }
    const meta = await this.wa(id);
    const r = await this.f(meta.url, { headers: auth });
    if (!r.ok) throw new Error('mídia ' + r.status);
    return { bytes: await r.arrayBuffer(), mime: meta.mime_type || 'image/jpeg' };
  }
}

/* ---------------- leitura do hodômetro ---------------- */
const PROMPT = `Você recebe uma foto que deveria mostrar o PAINEL (quadro de instrumentos) de um carro.
Leia o HODÔMETRO TOTAL (ODO / quilometragem total do carro).
NUNCA use o hodômetro parcial (TRIP, TRIP A, TRIP B, "A", "B"), velocímetro, conta-giros, autonomia, temperatura, relógio ou consumo.
Se aparecerem dois números de km, o total é o maior e costuma vir rotulado ODO ou sem rótulo de TRIP.
Responda SOMENTE com JSON: {"painel": true|false, "odometro": inteiro ou null, "certeza": "alta"|"media"|"baixa", "obs": "texto curto"}.
"painel" = false se a foto não for de um painel de carro. "odometro" = null se não der para ler com segurança.`;

function b64(buf) {
  if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function lerOdometro(ctx, midia) {
  const modelos = [ctx.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean);
  const corpo = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: midia.mime.split(';')[0], data: b64(midia.bytes) } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  let ultimoErro = '';
  for (const m of modelos) {
    const r = await ctx.f(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.env.GEMINI_KEY }, body: JSON.stringify(corpo)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { ultimoErro = `${m}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`; continue; }
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '';
    return interpretarResposta(txt);
  }
  throw new Error('Gemini: ' + ultimoErro);
}

function interpretarResposta(txt) {
  let o = {};
  try { o = JSON.parse(String(txt).replace(/```json|```/g, '').trim()); } catch (e) {
    const m = String(txt).match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (e2) { } }
  }
  let km = o.odometro;
  if (typeof km === 'string') km = Number(km.replace(/\D/g, ''));
  km = Number.isFinite(km) && km > 0 && km < 2e6 ? Math.round(km) : null;
  const certeza = String(o.certeza || '').toLowerCase();
  return { painel: o.painel !== false, km: certeza === 'baixa' ? null : km, certeza, obs: String(o.obs || '').slice(0, 200) };
}

/* ---------------- regras de manutenção ---------------- */
function kmRef(c) { return Math.max(num(c.kmUltima, 0), num(c.kmAtual, 0)); }
function dataRef(c) { return /^\d{4}-\d{2}-\d{2}$/.test(c.kmUltimaData || '') ? c.kmUltimaData : ''; }

/* leitura plausível? (rodando de aplicativo: até ~600 km/dia + folga) */
function plausivel(c, km, agora) {
  const ref = kmRef(c); if (!ref) return true;
  if (km < ref - 100) return false;
  const dr = dataRef(c); const dias = dr ? Math.max(1, (agora - Date.parse(dr + 'T12:00:00-03:00')) / DIA) : 60;
  return km - ref <= 600 * dias + 3000;
}

function textoResposta(c, km) {
  const L = [`✅ Recebido! Km registrado: *${fmtKm(km)}*`];
  const po = num(c.proxOleoKm, 0);
  if (po) {
    const f = po - km;
    if (f <= 0) L.push(`🛢 Troca de óleo: *VENCIDA há ${fmtKm(-f)} km* (era aos ${fmtKm(po)} km). Agende o quanto antes.`);
    else L.push(`🛢 Próxima troca de óleo: faltam *${fmtKm(f)} km* (aos ${fmtKm(po)} km)${f <= 1000 ? ' ⚠️ já agende' : ''}.`);
  }
  const pc = num(c.proxCorreiaKm, 0);
  if (c.temCorreia && pc) {
    const f = pc - km;
    if (f <= 0) L.push(`⚙️ Correia dentada: *VENCIDA há ${fmtKm(-f)} km* (era aos ${fmtKm(pc)} km). Agende o quanto antes.`);
    else L.push(`⚙️ Correia dentada: faltam *${fmtKm(f)} km* (aos ${fmtKm(pc)} km)${f <= 2000 ? ' ⚠️ já agende' : ''}.`);
  }
  L.push('', '_Mensagem automática · Guimas Car_');
  return L.join('\n');
}

/* ---------------- lista de motoristas (do Gestão) ---------------- */
async function carregar(ctx) {
  const [carros, estado, config] = await Promise.all([ctx.get('gestao/carros'), ctx.get('robo/estado'), ctx.get('robo/config')]);
  return { carros: carros || {}, estado: estado || {}, config: config || {} };
}
function elegivel(c) { return c && c.status === 'ativo' && String(c.motorista || '').trim() && !c.emVenda; }

/* ---------------- ciclo (cron) ---------------- */
async function ciclo(ctx, { simular = false, forcar = false } = {}) {
  const agora = Date.now();
  const { carros, estado, config } = await carregar(ctx);
  const relat = { versao: VERSAO, em: agora, simular, enviados: [], janelaGratis: [], atrasados: [], semTelefone: [], erros: [], pulados: [] };
  if (!config.ativo && !simular && !forcar) { relat.pulados.push('robô desligado (robo/config/ativo)'); return relat; }
  const fones = estado.fones || {}, mot = estado.motoristas || {};
  const upd = {}; const LIM = 44;

  for (const pk of Object.keys(carros).sort()) {
    if (ctx.sub >= LIM) { relat.pulados.push('limite desta execução — continua na próxima hora'); break; }
    const c = carros[pk];
    if (!elegivel(c)) { if (fones[pk] && !simular) upd['fones/' + pk] = null; continue; }
    /* telefone do contrato vigente (guardado em cache para não reler todo dia) */
    let fo = fones[pk];
    const ctId = c.contratoVigenteId || '';
    if (!fo || fo.ct !== ctId || fo.motorista !== c.motorista) {
      let tel = '';
      if (ctId) { const loc = await ctx.get(`gestao/contratos/${ctId}/locatario`).catch(() => null); tel = (loc && loc.tel) || ''; }
      fo = { ct: ctId, motorista: c.motorista, tel, chave: foneChave(tel), envio: foneEnvio(tel) };
      upd['fones/' + pk] = fo;
    }
    if (!fo.envio) { relat.semTelefone.push(`${c.nome || pk} — ${c.motorista}`); continue; }

    let m = mot[pk] || {};
    if (m.chave && m.chave !== fo.chave) m = {}; /* trocou de motorista: recomeça */
    if (m.aberto) {
      if (agora - m.pedidoEm >= ctx.alerta * DIA) {
        relat.atrasados.push(`${c.nome || pk} — ${c.motorista} (pedido em ${brDate(dataBRT(m.pedidoEm))})`);
        if (!m.atrasado) { m.atrasado = true; upd['motoristas/' + pk] = m; }
      }
      continue;
    }
    const dr = dataRef(c); const tRef = dr ? Date.parse(dr + 'T12:00:00-03:00') : 0;
    const base = Math.max(num(m.leituraEm, 0), num(m.pedidoEm, 0), tRef);
    if (!forcar && agora - base < ctx.intervalo * DIA) continue;

    const janela = m.ultimaMsgEm && agora - m.ultimaMsgEm < 23 * 3600e3;
    const nome = primeiroNome(c.motorista), carro = `${c.nome || 'carro'} ${fmtPlaca(c.placa || pk)}`.trim();
    try {
      if (!simular) {
        if (janela) await ctx.texto(fo.envio, `Olá, ${nome}! Para mantermos a manutenção do ${carro} em dia, envie uma foto do painel com a quilometragem (hodômetro) aparecendo. Assim que chegar, respondo quanto falta para a troca de óleo e da correia dentada. Obrigado!\n\n_Mensagem automática · Guimas Car_`);
        else await ctx.modelo(fo.envio, [nome, carro]);
        upd['motoristas/' + pk] = { ...m, chave: fo.chave, aberto: true, pedidoEm: agora, atrasado: false, falhas: 0, suspeito: null, motorista: c.motorista };
      }
      (janela ? relat.janelaGratis : relat.enviados).push(`${carro} — ${c.motorista} (${fo.envio})`);
    } catch (e) { relat.erros.push(`${carro}: ${e.message}`); }
  }
  if (!simular) {
    upd['status'] = { versao: VERSAO, ultimaExecucao: agora, enviados: relat.enviados.length + relat.janelaGratis.length, erros: relat.erros.slice(0, 5), semTelefone: relat.semTelefone, atrasados: relat.atrasados };
    if (Object.keys(upd).length) await ctx.patch('robo/estado', upd);
  }
  return relat;
}

/* ---------------- mensagens recebidas (webhook) ---------------- */
async function processarWebhook(ctx, corpo) {
  const msgs = [];
  for (const e of corpo.entry || []) for (const ch of e.changes || []) {
    if (ch.field !== 'messages') continue; /* ignora ecos do app (smb_message_echoes), status etc. */
    for (const m of (ch.value && ch.value.messages) || []) msgs.push(m);
  }
  if (!msgs.length) return { ok: true, msgs: 0 };
  const estado = (await ctx.get('robo/estado')) || {};
  const fones = estado.fones || {}, mot = estado.motoristas || {};
  const porChave = {};
  for (const pk of Object.keys(fones)) if (fones[pk] && fones[pk].chave) porChave[fones[pk].chave] = { key: pk, pk };
  const teste = estado.teste && estado.teste.chave && estado.teste.ate > Date.now() ? estado.teste : null;
  if (teste) porChave[teste.chave] = { key: 'teste', pk: teste.pk };

  const out = [];
  for (const msg of msgs) {
    const alvo = porChave[foneChave(msg.from)];
    if (!alvo) { out.push('desconhecido'); continue; } /* não é motorista: o robô não mexe */
    const { key, pk } = alvo;
    const m = { ...(mot[key] || {}) };
    const vistos = m.vistos || [];
    if (vistos.includes(msg.id)) { out.push('repetida'); continue; }
    m.vistos = [msg.id, ...vistos].slice(0, 15);
    m.ultimaMsgEm = Date.now();
    const para = msg.from; /* responde exatamente a quem mandou */
    try {
      if (msg.type === 'image' && msg.image && msg.image.id && m.aberto) {
        out.push(await tratarFoto(ctx, pk, m, msg, para, key === 'teste'));
      } else out.push('ignorada:' + msg.type);
    } catch (e) {
      out.push('erro:' + e.message);
      await ctx.post('robo/erros', { em: Date.now(), pk, erro: String(e.message).slice(0, 300) }).catch(() => { });
    }
    await ctx.put('robo/estado/motoristas/' + key, m);
    mot[key] = m;
  }
  return { ok: true, out };
}

async function tratarFoto(ctx, pk, m, msg, para, teste) {
  const agora = Date.now();
  const c = (await ctx.get('gestao/carros/' + pk)) || {};
  const midia = await ctx.baixarMidia(msg.image.id);
  const lido = await lerOdometro(ctx, midia);
  const reg = { em: agora, km: lido.km, painel: lido.painel, certeza: lido.certeza, obs: lido.obs };

  if (!lido.painel || !lido.km) {
    m.falhas = num(m.falhas, 0) + 1;
    await ctx.post('robo/historico/' + (teste ? 'teste' : pk), { ...reg, pk, resultado: 'ilegivel' });
    if (m.falhas <= 2) await ctx.texto(para, 'Não consegui ler a quilometragem nessa foto 🤔 Manda outra, bem de perto do painel, com o hodômetro (km total) aparecendo, por favor.');
    return 'ilegivel';
  }
  const km = lido.km;
  if (!plausivel(c, km, agora) && !(m.suspeito && Math.abs(m.suspeito - km) <= 100)) {
    m.suspeito = km;
    await ctx.post('robo/historico/' + (teste ? 'teste' : pk), { ...reg, pk, resultado: 'conferir' });
    await ctx.texto(para, `Li ${fmtKm(km)} km, mas não bateu com o último registro do carro. Manda mais uma foto bem de perto do hodômetro (km total, não o TRIP), por favor.`);
    return 'conferir';
  }
  const leitura = { km, data: dataBRT(agora), em: agora, motorista: c.motorista || '', certeza: lido.certeza };
  if (!teste) await ctx.put('robo/leituras/' + pk, leitura); /* teste não mexe no km do Gestão */
  await ctx.post('robo/historico/' + (teste ? 'teste' : pk), { ...reg, pk, resultado: 'ok' });
  Object.assign(m, { aberto: false, atrasado: false, leituraEm: agora, km, falhas: 0, suspeito: null });
  await ctx.texto(para, textoResposta(c, km));
  return 'ok:' + km;
}

/* ---------------- modelo de mensagem (template) ---------------- */
const MODELO = {
  name: 'foto_painel_km', language: 'pt_BR', category: 'UTILITY',
  components: [{
    type: 'BODY',
    text: 'Olá, {{1}}! Para mantermos a manutenção do {{2}} em dia, envie uma foto do painel com a quilometragem (hodômetro) aparecendo. Assim que recebermos, respondemos quanto falta para a próxima troca de óleo e da correia dentada. Obrigado! Guimas Car',
    example: { body_text: [['Carlos', 'Logan Branco 2019 QQF-8J26']] }
  }]
};

/* ---------------- HTTP ---------------- */
const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });

async function http(req, env, exec) {
  const url = new URL(req.url); const p = url.pathname.split('/').filter(Boolean);
  if (!p.length) return new Response('robô do km · ok', { status: 200 });
  const ctx = await new Ctx(env).init();

  /* webhook do WhatsApp: /wh/<código> */
  if (p[0] === 'wh' && p[1] === ctx.wh) {
    if (req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === (env.VERIFY_TOKEN || 'guimascar-robo-km')) return new Response(q.get('hub.challenge') || '', { status: 200 });
      return new Response('forbidden', { status: 403 });
    }
    if (req.method === 'POST') {
      const corpo = await req.json().catch(() => ({}));
      exec.waitUntil(processarWebhook(ctx, corpo).catch(e => ctx.post('robo/erros', { em: Date.now(), erro: 'webhook: ' + String(e.message).slice(0, 300) }).catch(() => { })));
      return new Response('ok', { status: 200 });
    }
  }

  /* administração: /adm/<código>/<ação> */
  if (p[0] === 'adm' && p[1] === ctx.admin) {
    const acao = p[2] || 'ajuda', q = url.searchParams;
    if (acao === 'ajuda') return J({ versao: VERSAO, webhook: `${url.origin}/wh/${ctx.wh}`, verify_token: env.VERIFY_TOKEN || 'guimascar-robo-km', acoes: ['simular', 'rodar', 'ligar', 'desligar', 'modelo', 'modelos', 'teste?para=55DDDNUMERO&pk=PLACA', 'estado'] });
    if (acao === 'simular') return J(await ciclo(ctx, { simular: true }));
    if (acao === 'rodar') return J(await ciclo(ctx, { forcar: q.get('forcar') === '1' }));
    if (acao === 'ligar' || acao === 'desligar') { await ctx.patch('robo/config', { ativo: acao === 'ligar', em: Date.now() }); return J({ ativo: acao === 'ligar' }); }
    if (acao === 'estado') return J(await ctx.get('robo'));
    if (acao === 'modelo') return J(await ctx.wa(`${env.WABA_ID}/message_templates`, MODELO));
    if (acao === 'modelos') return J(await ctx.wa(`${env.WABA_ID}/message_templates?fields=name,status,category,language`));
    if (acao === 'teste') {
      const para = foneEnvio(q.get('para')); const pk = String(q.get('pk') || '').toUpperCase();
      if (!para || !pk) return J({ erro: 'use ?para=55DDDNUMERO&pk=PLACA' }, 400);
      const c = (await ctx.get('gestao/carros/' + pk)) || {};
      await ctx.patch('robo/estado', { teste: { chave: foneChave(para), pk, ate: Date.now() + DIA }, 'motoristas/teste': { aberto: true, pedidoEm: Date.now(), pk } });
      const r = await ctx.modelo(para, [primeiroNome(c.motorista) || 'Teste', `${c.nome || 'carro'} ${fmtPlaca(pk)}`]);
      return J({ enviado: para, carro: c.nome, resposta: r });
    }
    return J({ erro: 'ação desconhecida' }, 404);
  }
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(req, env, exec) {
    try { return await http(req, env, exec); }
    catch (e) { return J({ erro: e.message }, 500); }
  },
  async scheduled(evt, env, exec) {
    exec.waitUntil((async () => {
      const ctx = await new Ctx(env).init();
      try { await ciclo(ctx); }
      catch (e) { await ctx.post('robo/erros', { em: Date.now(), erro: 'cron: ' + String(e.message).slice(0, 300) }).catch(() => { }); }
    })());
  }
};

/* exportado só para os testes locais */
export const _t = { foneChave, foneEnvio, interpretarResposta, plausivel, textoResposta, ciclo, processarWebhook, Ctx, primeiroNome, fmtPlaca };
