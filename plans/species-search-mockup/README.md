# Species-Suche – Mockup

Vergleich alte Liste ↔ gruppierte Zwei-Zeilen-Liste (umgesetzt in `species-ranking.ts` / `taxonomy-ui.ts`).

Der Taxonomie-Auszug ist nicht eingecheckt (1,3 MB). Erzeugen mit (aus diesem Ordner):

```sh
node -e 'const t=require("../../demo/data/birdnet-taxonomy.v2.4.json");require("fs").writeFileSync("taxonomy-subset.js","window.TAX="+JSON.stringify(t.records.map(x=>[x.s,x.n?.de||"",x.n?.en_uk||"",x.n?.fr||"",x.n?.nl||"",x.x?1:0]))+";")'
```

`local-list.js` simuliert die Artenliste des Geo-Modells (Mitteleuropa, Mai).
