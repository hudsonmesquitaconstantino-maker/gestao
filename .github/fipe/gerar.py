# Espelho próprio da Tabela FIPE (carros) para o Gestão.
# Fonte: dataset público CC0 fipex-labs/dataset (dump mensal da FIPE). Gera arquivos pequenos em /fipe
# que o app usa quando as APIs ao vivo (parallelum v1/v2, BrasilAPI) estão fora do ar.
import json, os, re, sys, unicodedata
import pandas as pd

src, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]
MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']
COMB = {'g':1,'a':2,'d':3,'f':4,'e':5,'h':6}

d = pd.read_parquet(src)
d = d[d.tipo_veiculo == 'carro']
ar = int(d.ano_referencia.max()); mr = int(d[d.ano_referencia == ar].mes_referencia.max())
d = d[(d.ano_referencia == ar) & (d.mes_referencia == mr)].copy()
if len(d) < 15000: sys.exit('poucos carros no mês %d/%d: %d' % (mr, ar, len(d)))
mes = '%s de %d' % (MESES[mr-1], ar)

def slug(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')

def ano_info(r):
    zk = bool(r.zero_km) or pd.isna(r.ano_modelo) or int(r.ano_modelo) >= 32000
    a = 32000 if zk else int(r.ano_modelo)
    sig = str(r.sigla_combustivel or 'g').lower()[:1]
    comb = str(r.nome_combustivel or 'Gasolina')
    return a, COMB.get(sig, 1), comb

os.makedirs(out + '/marca', exist_ok=True); os.makedirs(out + '/cod', exist_ok=True)
for f in os.listdir(out + '/marca'): os.remove(out + '/marca/' + f)
for f in os.listdir(out + '/cod'): os.remove(out + '/cod/' + f)

marcas = []; porCod = {}
for marca, g in d.groupby('nome_marca'):
    mk = 'mx-' + slug(marca); mods = []
    for (cod, nome), h in g.groupby(['codigo_fipe','nome_modelo']):
        anos = []
        for r in h.itertuples():
            a, cn, comb = ano_info(r)
            anos.append([str(a) + '-' + str(cn), ('Zero KM' if a == 32000 else str(a)) + ' ' + comb, int(r.valor_centavos)])
            porCod.setdefault(cod, []).append([a, comb, int(r.valor_centavos), marca, nome])
        anos.sort(key=lambda x: x[0], reverse=True)
        mods.append({'codigo': 'mc-' + cod, 'nome': nome, 'anos': anos})
    mods.sort(key=lambda m: m['nome'])
    marcas.append({'codigo': mk, 'nome': marca})
    json.dump({'marca': marca, 'mes': mes, 'modelos': mods}, open(out + '/marca/' + mk + '.json','w'), ensure_ascii=False, separators=(',',':'))
marcas.sort(key=lambda m: m['nome'])
json.dump(marcas, open(out + '/marcas.json','w'), ensure_ascii=False, separators=(',',':'))
grupos = {}
for cod, lst in porCod.items(): grupos.setdefault(cod[:3], {})[cod] = lst
for k, v in grupos.items(): json.dump(v, open(out + '/cod/' + k + '.json','w'), ensure_ascii=False, separators=(',',':'))
json.dump({'mes': mes, 'ref': '%d-%02d' % (ar, mr), 'fonte': 'fipex-labs/dataset ' + tag, 'carros': len(d), 'modelos': len(porCod), 'marcas': len(marcas)},
          open(out + '/info.json','w'), ensure_ascii=False, indent=1)
print('ok', mes, len(d), 'linhas', len(porCod), 'modelos', len(marcas), 'marcas')
