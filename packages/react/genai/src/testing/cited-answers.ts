import type { UIMessage } from 'ai';

/**
 * Three cited answers in the shape a consumer's recorded answers have, each
 * as two converters give it: one text part per agent text block, and one text
 * part per paragraph, whose citations arrive at each paragraph's text-end.
 * The words are filler of the same length; the part boundaries, the citation
 * offsets and every Markdown mark are as recorded.
 */
export const citedAnswers: {
  answer: string;
  oneBlock: UIMessage['parts'];
  perParagraph: UIMessage['parts'];
}[] = [
  {
    answer: 'answer 1',
    oneBlock: [
      {
        type: 'text',
        text: '**Loremipsu mdol-orsi (tam etc-onsectetura)**\n\n- **Dipiscingelits eddoeiusmod/temporincidid (Untutlab) 100 or EE t12d olor emag naa 7 liqu** — alo remip sumdolo rsi tametc (o 5–7 nse ctetur ad ipis cingelits ed doe iusmodtemp). Or in cididun tutl abo reetd oloremagnaali qualorem ips um *D. olor* si *T. ametconsectet*.\n- **Uradipisci ngelitsedd 3 o EI usmo** — d tempor inci, didunt utla boreetdolorema gn aaliqualore mipsu-mdol orsitam etc onsecteturadi piscinge. Li tsedd oe iusmodt empo rincididun tu tlabor\n- **Eetdoloremagn (AALIQ) 185 ua LO remip sumdo lorsi tam 3–7 etco**, NSE-cteturad ipi scing ≥18 elit sEDD. Oeiusmodtemp or inc ID id untut laboree.\n\n**Tdolor ema gnaa**\n- Liqua lorem ipsumdol: orsitametconse ct eturadipiscinge lits eddoeiusmod tempo rincididun, "tutlaboree tdolorema gnaal 60 iQ ual oremip". Sumdolorsi ta metconsectetu ra dip iscing elitse dd OeIu sm odt.\n- Emporincididun tutl abo reetd oloremagnaaliq — ua lorem ip sumdo, lorsi tame tc onsectet uradipi, scin ge lit s eddoeius modt emp orinc i diduntutl abor eet dolore.\n- Ma gnaal-iqualoremi psumdol orsi tam etcon secte turadipisc; inge lits eddoe-iusmodtemp orincid iduntutlaboree tdo loremagnaali qua lor emip sumdolor.\n- Sita metconsecteturad ip iscin-geli tsed. Doeiusmodtem porin cid idun tutl abo reetd-oloremag naaliqua, lor em ip sum dolorsit am e tconse ctetu ra dip IS, ci ng el itseddo eiu s modtempor incidi; duntu *T. labo* reetdolore ma gnaaliqualor emip sumdol or.\n\nSi: tametconsectet 100 ur ADI × 7 pisc in GeLi ≥60, tseddoeiu smodtempor 3 i ncid (id untutlaboreet do loremag).',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-1',
              url: 'https://example.org/source-1',
              title: 'Source 1',
            },
            startIndex: 49,
            endIndex: 171,
            citedText: 'Lor 100 em ipsumdo lorsi 12 tamet con secte tura.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-2',
              url: 'https://example.org/source-2',
              title: 'Source 2',
            },
            startIndex: 172,
            endIndex: 225,
            citedText:
              'loremipsumdolo rsitametcon/secteturadipi (100 sc ingel itsed doe 5-7 iusm)',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-3',
              url: 'https://example.org/source-1',
              title: 'Source 1',
            },
            startIndex: 228,
            endIndex: 318,
            citedText:
              'loremipsu mdol ors ita metconsec te turad ipiscingelits eddoeiu smodt emporincid (idunt utlabore) etdolo re magnaaliqua loremip su Mdolorsitam etco ns Ecteturadipisc ingelitseddoe',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-2',
              url: 'https://example.org/source-2',
              title: 'Source 2',
            },
            startIndex: 322,
            endIndex: 464,
            citedText:
              'loremipsum dolorsitam (3 e tc o nsecte tura) dip isc ingelitsedd oeius-modt emporinci did untutlaboreet dolorema',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-4',
              url: 'https://example.org/source-3',
              title: 'Source 3',
            },
            startIndex: 466,
            endIndex: 511,
            citedText:
              'Lo remips umdolorsita met consecte tu radipis cingelit, se ddoeiusm odtempor, in ci didunt utlab or eetdolo remagnaali.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-5',
              url: 'https://example.org/source-4',
              title: 'Source 4',
            },
            startIndex: 514,
            endIndex: 580,
            citedText: 'lor 185 em ipsumd olorsi 3 tamet c ons ect 3 et 7 urad',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-6',
              url: 'https://example.org/source-4',
              title: 'Source 4',
            },
            startIndex: 582,
            endIndex: 618,
            citedText:
              'loremipsu mdo lor sitametco ns ectetu radipisc 18 ingel it sed doe iusmo dtem porincididunt utlabor eetdo loremagnaa',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-7',
              url: 'https://example.org/source-5',
              title: 'Source 5',
            },
            startIndex: 684,
            endIndex: 820,
            citedText:
              'Loremi, psumdolo, rs itametconse cteturadip is cinge litseddo (eiusmodtem porincidi duntu 60 tL abo reetdo lo remagnaali qualoremips umdolors itame tconsectet) ura dipiscingelitsedd.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-8',
              url: 'https://example.org/source-6',
              title: 'Source 6',
            },
            startIndex: 1056,
            endIndex: 1205,
            citedText:
              'Lorem-ipsumdolor sita metconsecte tur adipiscingel its edd oeiu smodtemp',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-9',
              url: 'https://example.org/source-7',
              title: 'Source 7',
            },
            startIndex: 1209,
            endIndex: 1249,
            citedText:
              'Loremipsumdolors ita met conse-ctet uradipi sci nGELi tseddoeiu smo dt empori ncididun tut labo reetdo loremagnaa liqua.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-10',
              url: 'https://example.org/source-8',
              title: 'Source 8',
            },
            startIndex: 1251,
            endIndex: 1311,
            citedText: 'lo REM ipsum dol orsitame tcon secte turadipis',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-1',
        url: 'https://example.org/source-1',
        title: 'Source 1',
      },
      {
        type: 'source-url',
        sourceId: 'source-2',
        url: 'https://example.org/source-2',
        title: 'Source 2',
      },
      {
        type: 'source-url',
        sourceId: 'source-3',
        url: 'https://example.org/source-1',
        title: 'Source 1',
      },
      {
        type: 'source-url',
        sourceId: 'source-4',
        url: 'https://example.org/source-3',
        title: 'Source 3',
      },
      {
        type: 'source-url',
        sourceId: 'source-5',
        url: 'https://example.org/source-4',
        title: 'Source 4',
      },
      {
        type: 'source-url',
        sourceId: 'source-6',
        url: 'https://example.org/source-4',
        title: 'Source 4',
      },
      {
        type: 'source-url',
        sourceId: 'source-7',
        url: 'https://example.org/source-5',
        title: 'Source 5',
      },
      {
        type: 'source-url',
        sourceId: 'source-8',
        url: 'https://example.org/source-6',
        title: 'Source 6',
      },
      {
        type: 'source-url',
        sourceId: 'source-9',
        url: 'https://example.org/source-7',
        title: 'Source 7',
      },
      {
        type: 'source-url',
        sourceId: 'source-10',
        url: 'https://example.org/source-8',
        title: 'Source 8',
      },
    ],
    perParagraph: [
      {
        type: 'text',
        text: '**Loremipsu mdol-orsi (tam etc-onsectetura)**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: '- **Dipiscingelits eddoeiusmod/temporincidid (Untutlab) 100 or EE t12d olor emag naa 7 liqu** — alo remip sumdolo rsi tametc (o 5–7 nse ctetur ad ipis cingelits ed doe iusmodtemp). Or in cididun tutl abo reetd oloremagnaali qualorem ips um *D. olor* si *T. ametconsectet*.\n- **Uradipisci ngelitsedd 3 o EI usmo** — d tempor inci, didunt utla boreetdolorema gn aaliqualore mipsu-mdol orsitam etc onsecteturadi piscinge. Li tsedd oe iusmodt empo rincididun tu tlabor\n- **Eetdoloremagn (AALIQ) 185 ua LO remip sumdo lorsi tam 3–7 etco**, NSE-cteturad ipi scing ≥18 elit sEDD. Oeiusmodtemp or inc ID id untut laboree.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-1',
              url: 'https://example.org/source-1',
              title: 'Source 1',
            },
            startIndex: 2,
            endIndex: 124,
            citedText: 'Lor 100 em ipsumdo lorsi 12 tamet con secte tura.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-2',
              url: 'https://example.org/source-2',
              title: 'Source 2',
            },
            startIndex: 125,
            endIndex: 178,
            citedText:
              'loremipsumdolo rsitametcon/secteturadipi (100 sc ingel itsed doe 5-7 iusm)',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-3',
              url: 'https://example.org/source-1',
              title: 'Source 1',
            },
            startIndex: 181,
            endIndex: 271,
            citedText:
              'loremipsu mdol ors ita metconsec te turad ipiscingelits eddoeiu smodt emporincid (idunt utlabore) etdolo re magnaaliqua loremip su Mdolorsitam etco ns Ecteturadipisc ingelitseddoe',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-2',
              url: 'https://example.org/source-2',
              title: 'Source 2',
            },
            startIndex: 275,
            endIndex: 417,
            citedText:
              'loremipsum dolorsitam (3 e tc o nsecte tura) dip isc ingelitsedd oeius-modt emporinci did untutlaboreet dolorema',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-4',
              url: 'https://example.org/source-3',
              title: 'Source 3',
            },
            startIndex: 419,
            endIndex: 464,
            citedText:
              'Lo remips umdolorsita met consecte tu radipis cingelit, se ddoeiusm odtempor, in ci didunt utlab or eetdolo remagnaali.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-5',
              url: 'https://example.org/source-4',
              title: 'Source 4',
            },
            startIndex: 467,
            endIndex: 533,
            citedText: 'lor 185 em ipsumd olorsi 3 tamet c ons ect 3 et 7 urad',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-6',
              url: 'https://example.org/source-4',
              title: 'Source 4',
            },
            startIndex: 535,
            endIndex: 571,
            citedText:
              'loremipsu mdo lor sitametco ns ectetu radipisc 18 ingel it sed doe iusmo dtem porincididunt utlabor eetdo loremagnaa',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-1',
        url: 'https://example.org/source-1',
        title: 'Source 1',
      },
      {
        type: 'source-url',
        sourceId: 'source-2',
        url: 'https://example.org/source-2',
        title: 'Source 2',
      },
      {
        type: 'source-url',
        sourceId: 'source-3',
        url: 'https://example.org/source-1',
        title: 'Source 1',
      },
      {
        type: 'source-url',
        sourceId: 'source-4',
        url: 'https://example.org/source-3',
        title: 'Source 3',
      },
      {
        type: 'source-url',
        sourceId: 'source-5',
        url: 'https://example.org/source-4',
        title: 'Source 4',
      },
      {
        type: 'source-url',
        sourceId: 'source-6',
        url: 'https://example.org/source-4',
        title: 'Source 4',
      },
      {
        type: 'text',
        text: '**Tdolor ema gnaa**\n- Liqua lorem ipsumdol: orsitametconse ct eturadipiscinge lits eddoeiusmod tempo rincididun, "tutlaboree tdolorema gnaal 60 iQ ual oremip". Sumdolorsi ta metconsectetu ra dip iscing elitse dd OeIu sm odt.\n- Emporincididun tutl abo reetd oloremagnaaliq — ua lorem ip sumdo, lorsi tame tc onsectet uradipi, scin ge lit s eddoeius modt emp orinc i diduntutl abor eet dolore.\n- Ma gnaal-iqualoremi psumdol orsi tam etcon secte turadipisc; inge lits eddoe-iusmodtemp orincid iduntutlaboree tdo loremagnaali qua lor emip sumdolor.\n- Sita metconsecteturad ip iscin-geli tsed. Doeiusmodtem porin cid idun tutl abo reetd-oloremag naaliqua, lor em ip sum dolorsit am e tconse ctetu ra dip IS, ci ng el itseddo eiu s modtempor incidi; duntu *T. labo* reetdolore ma gnaaliqualor emip sumdol or.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-7',
              url: 'https://example.org/source-5',
              title: 'Source 5',
            },
            startIndex: 22,
            endIndex: 158,
            citedText:
              'Loremi, psumdolo, rs itametconse cteturadip is cinge litseddo (eiusmodtem porincidi duntu 60 tL abo reetdo lo remagnaali qualoremips umdolors itame tconsectet) ura dipiscingelitsedd.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-8',
              url: 'https://example.org/source-6',
              title: 'Source 6',
            },
            startIndex: 394,
            endIndex: 543,
            citedText:
              'Lorem-ipsumdolor sita metconsecte tur adipiscingel its edd oeiu smodtemp',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-9',
              url: 'https://example.org/source-7',
              title: 'Source 7',
            },
            startIndex: 547,
            endIndex: 587,
            citedText:
              'Loremipsumdolors ita met conse-ctet uradipi sci nGELi tseddoeiu smo dt empori ncididun tut labo reetdo loremagnaa liqua.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-10',
              url: 'https://example.org/source-8',
              title: 'Source 8',
            },
            startIndex: 589,
            endIndex: 649,
            citedText: 'lo REM ipsum dol orsitame tcon secte turadipis',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-7',
        url: 'https://example.org/source-5',
        title: 'Source 5',
      },
      {
        type: 'source-url',
        sourceId: 'source-8',
        url: 'https://example.org/source-6',
        title: 'Source 6',
      },
      {
        type: 'source-url',
        sourceId: 'source-9',
        url: 'https://example.org/source-7',
        title: 'Source 7',
      },
      {
        type: 'source-url',
        sourceId: 'source-10',
        url: 'https://example.org/source-8',
        title: 'Source 8',
      },
      {
        type: 'text',
        text: 'Si: tametconsectet 100 ur ADI × 7 pisc in GeLi ≥60, tseddoeiu smodtempor 3 i ncid (id untutlaboreet do loremag).',
        state: 'done',
      },
    ],
  },
  {
    answer: 'answer 2',
    oneBlock: [
      {
        type: 'text',
        text: '**Lorem ipsumd: olors it am etcon sectetu. Rad ipisc\'i ngelitse dd oe iusmodt emporinc idid u ntutlabore etdoloremagna, ali qu alo remipsum dol orsitame tconsect.**\n\n**Etu radipiscin**\n\nGelitseddoe iusmodte mpo rinci diduntut (labo r eetdolorem agnaaliqualor) emip sum *dolo* rsitamet cons ectet urad ipis cin. Geli tse ddoeiusmod tempo rinc idi DUN tu tl ab oreetdolor emagn\n\nAa "liqualo" remi psumd olorsit am etconsec tetu radipis/cingelitse, ddo eius modtempo. Rincidid unt ut laboreet-dolorema gnaaliqualo remi psumdolo — rsi tamet co nsecte turad ipiscingelit sedd oeiu sm odtemporincid iduntu.\n\n**Tla bor eetdol orem agnaa liq UAL oremi**\n\nPsumdolo rsitamet con SEC, te turad ipiscing elitse ddo eiusmodtem por inc ididuntu tla boreetdol oremagna. Al IQU alore mipsu mdolorsi ta metco ns ectet ura dipi scingelitse ddoe ius modtempo rincid id untutlab oreetdoloremag — naal iq ual orem.\n\nIps umdolorsitametc onsect et uradipis cingelit se ddoei 24 usmod tempo rin cidi dunt, utlab ore etdo-lorem. Ag na ALI qu alor emipsumdolors it a metconse CTE turad ipiscing eli tseddoe; iu smodtemp orin ci di duntu tlabo REEt do lore magna ali qualorem ipsum dol orsitametco nsectetu rad ipiscingeli, tsed doei usm odtemporin cidid.\n\n**Unt utla boreetd — olo rema gn aali**\n\nQu ALOREMIPS, umdolors itametcons ect etura dipi scingeli ts e DDO eius m 2-odt empori nc ididuntutlaboree td oloremag naa LIQ, ual orem ipsu mdo lorsitamet consecteturadi pisci ngelitse ddoeiusm odtem porincidi d untutl aboreetdolo REM. Ag naaliqual orem ip sumdol ors itametco nsecte tur adipiscing elit seddoeiu sm odtempor. I 2-nci diduntutlaboreet dolore magna al iqualorem ips umdolors itametco.\n\n**Nsect eturadipis**\n\nCing el itsed do eius modtempor. Inci diduntu tlaboreet, doloremag naaliqua lo remipsum dolorsitame tc onse c teturadip iscing el its EDD oei usmodtemp orincididun tutlaboreetdolo. Re magn a aliqual ore MIP sum dolo rsitame tconsect etu radi, pis cin gel itsedd oeiu-smodte (mporinci) di duntu-tlab oreetdol. Oremagna aliq-Ua loremi psum dolo rsit am e tcon se ctetu rad ipiscingel its eddoe iusmodtempo rincididun tutlabor.\n\n**Eetdolore magnaali**\n\n1. Qual ore mipsumd olorsita; metco nsectetu radi pisc ing elit seddoeiusm/odtempo ri ncididuntut labo.\n2. Re etd olorema gnaaliqu al OREm ipsum do lor sitam ~24 etcon; sect etu radipiscinge li tseddoei.\n3. Usmo dtempori nci diduntu, tlabo REE tdolo; rema gna aliqualore mipsu mdol ors ITA me tconsectetu.\n4. Ra DIP, iscing e litsed doeiu smo dtempori ncididun tutl-Ab or e etdolo remagn aaliqu alor emipsumd ol orsit AME.\n\nTco nsectet ur adipisci ngelit se ddoe iusmodt: emporin cid idu ntutlaboree tdolorem agnaaliq ua l ORE-mipsu mdolors itame tconsecteturad ip iscinge litse, dd oeius MOD temp orinc idid untu tla bore etd olorema gn aaliqualo — remips umd olor si tame tconsect et u radipiscinge litse.',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-11',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 311,
            endIndex: 375,
            citedText:
              'Lor emipsumd ol or sitametcons ECTETUR adi pisci ngel i tseddoeius modtemporinci did untutlab or eet dolo rem agna aliq ua LOREMIP sumdo lors itam etcon, secteturadipi sci ngelitsedd oeiusmodtempo rinc IDI duntutl ab oreetdolor emagn.',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-11',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 647,
            endIndex: 753,
            citedText:
              'LOREMIP sumdolo RSI, ta metc onsecte TUR adipiscingel itsedd oei usmodtempo ri ncididun tut lab or eetdol ore magnaaliqua lor emipsumdolo rsit am etconsec',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-12',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 895,
            endIndex: 1002,
            citedText:
              'lor em ipsumdol or sitamet con se ctetu 24 radip iscin gel itse ddoe, i.u., smo dtemp ori ncid idun-tutla',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-13',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 1271,
            endIndex: 1507,
            citedText:
              'l 2-ore mipsum do lorsitametconsec te TURADIP isc ING, el itse ddoe iusmodte mpo rin cidi dunt utlaboreet doloremagnaali qualo remipsum DOLORSI tamet consectet u radipi sci ngelitseddo EIU',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-14',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 1509,
            endIndex: 1597,
            citedText:
              'Lo remipsumd olor si tametc ons ectetura dipisc ing elitseddoe iusm ODTEMPO ri ncididun tu tlaboree tdolor em agnaal iqualoremips umdolors',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-15',
              url: 'https://example.org/source-10',
              title: 'Source 10',
            },
            startIndex: 1729,
            endIndex: 1875,
            citedText:
              'loremipsu mdolorsi ta metconse cteturadipi sc inge l itseddoei usmodt em por INC idi duntutlab oreetdolore magnaa li qualoremipsumdo',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-15',
              url: 'https://example.org/source-10',
              title: 'Source 10',
            },
            startIndex: 2005,
            endIndex: 2119,
            citedText:
              'Loremipsumd ol orsitame tcon-Se ctetur adipi sc ing elitseddoe iusm odtempor in cididunt ut l aboreet dolo remagna aliqu aloremi psu mdolors itam etc onsectetur adipisci ngelits',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-11',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'source-url',
        sourceId: 'source-12',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'source-url',
        sourceId: 'source-13',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'source-url',
        sourceId: 'source-14',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'source-url',
        sourceId: 'source-15',
        url: 'https://example.org/source-10',
        title: 'Source 10',
      },
    ],
    perParagraph: [
      {
        type: 'text',
        text: "**Lorem ipsumd: olors it am etcon sectetu. Rad ipisc'i ngelitse dd oe iusmodt emporinc idid u ntutlabore etdoloremagna, ali qu alo remipsum dol orsitame tconsect.**\n\n",
        state: 'done',
      },
      {
        type: 'text',
        text: '**Etu radipiscin**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Gelitseddoe iusmodte mpo rinci diduntut (labo r eetdolorem agnaaliqualor) emip sum *dolo* rsitamet cons ectet urad ipis cin. Geli tse ddoeiusmod tempo rinc idi DUN tu tl ab oreetdolor emagn\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-11',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 125,
            endIndex: 189,
            citedText:
              'Lor emipsumd ol or sitametcons ECTETUR adi pisci ngel i tseddoeius modtemporinci did untutlab or eet dolo rem agna aliq ua LOREMIP sumdo lors itam etcon, secteturadipi sci ngelitsedd oeiusmodtempo rinc IDI duntutl ab oreetdolor emagn.',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-11',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'text',
        text: 'Aa "liqualo" remi psumd olorsit am etconsec tetu radipis/cingelitse, ddo eius modtempo. Rincidid unt ut laboreet-dolorema gnaaliqualo remi psumdolo — rsi tamet co nsecte turad ipiscingelit sedd oeiu sm odtemporincid iduntu.\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: '**Tla bor eetdol orem agnaa liq UAL oremi**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Psumdolo rsitamet con SEC, te turad ipiscing elitse ddo eiusmodtem por inc ididuntu tla boreetdol oremagna. Al IQU alore mipsu mdolorsi ta metco ns ectet ura dipi scingelitse ddoe ius modtempo rincid id untutlab oreetdoloremag — naal iq ual orem.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-11',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 0,
            endIndex: 106,
            citedText:
              'LOREMIP sumdolo RSI, ta metc onsecte TUR adipiscingel itsedd oei usmodtempo ri ncididun tut lab or eetdol ore magnaaliqua lor emipsumdolo rsit am etconsec',
          },
        ],
      },
      {
        type: 'text',
        text: 'Ips umdolorsitametc onsect et uradipis cingelit se ddoei 24 usmod tempo rin cidi dunt, utlab ore etdo-lorem. Ag na ALI qu alor emipsumdolors it a metconse CTE turad ipiscing eli tseddoe; iu smodtemp orin ci di duntu tlabo REEt do lore magna ali qualorem ipsum dol orsitametco nsectetu rad ipiscingeli, tsed doei usm odtemporin cidid.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-12',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 0,
            endIndex: 107,
            citedText:
              'lor em ipsumdol or sitamet con se ctetu 24 radip iscin gel itse ddoe, i.u., smo dtemp ori ncid idun-tutla',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-12',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'text',
        text: '**Unt utla boreetd — olo rema gn aali**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Qu ALOREMIPS, umdolors itametcons ect etura dipi scingeli ts e DDO eius m 2-odt empori nc ididuntutlaboree td oloremag naa LIQ, ual orem ipsu mdo lorsitamet consecteturadi pisci ngelitse ddoeiusm odtem porincidi d untutl aboreetdolo REM. Ag naaliqual orem ip sumdol ors itametco nsecte tur adipiscing elit seddoeiu sm odtempor. I 2-nci diduntutlaboreet dolore magna al iqualorem ips umdolors itametco.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-13',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 0,
            endIndex: 236,
            citedText:
              'l 2-ore mipsum do lorsitametconsec te TURADIP isc ING, el itse ddoe iusmodte mpo rin cidi dunt utlaboreet doloremagnaali qualo remipsum DOLORSI tamet consectet u radipi sci ngelitseddo EIU',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-14',
              url: 'https://example.org/source-9',
              title: 'Source 9',
            },
            startIndex: 238,
            endIndex: 326,
            citedText:
              'Lo remipsumd olor si tametc ons ectetura dipisc ing elitseddoe iusm ODTEMPO ri ncididun tu tlaboree tdolor em agnaal iqualoremips umdolors',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-13',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'source-url',
        sourceId: 'source-14',
        url: 'https://example.org/source-9',
        title: 'Source 9',
      },
      {
        type: 'text',
        text: '**Nsect eturadipis**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Cing el itsed do eius modtempor. Inci diduntu tlaboreet, doloremag naaliqua lo remipsum dolorsitame tc onse c teturadip iscing el its EDD oei usmodtemp orincididun tutlaboreetdolo. Re magn a aliqual ore MIP sum dolo rsitame tconsect etu radi, pis cin gel itsedd oeiu-smodte (mporinci) di duntu-tlab oreetdol. Oremagna aliq-Ua loremi psum dolo rsit am e tcon se ctetu rad ipiscingel its eddoe iusmodtempo rincididun tutlabor.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-15',
              url: 'https://example.org/source-10',
              title: 'Source 10',
            },
            startIndex: 33,
            endIndex: 179,
            citedText:
              'loremipsu mdolorsi ta metconse cteturadipi sc inge l itseddoei usmodt em por INC idi duntutlab oreetdolore magnaa li qualoremipsumdo',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-15',
              url: 'https://example.org/source-10',
              title: 'Source 10',
            },
            startIndex: 309,
            endIndex: 423,
            citedText:
              'Loremipsumd ol orsitame tcon-Se ctetur adipi sc ing elitseddoe iusm odtempor in cididunt ut l aboreet dolo remagna aliqu aloremi psu mdolors itam etc onsectetur adipisci ngelits',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-15',
        url: 'https://example.org/source-10',
        title: 'Source 10',
      },
      {
        type: 'text',
        text: '**Eetdolore magnaali**\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: '1. Qual ore mipsumd olorsita; metco nsectetu radi pisc ing elit seddoeiusm/odtempo ri ncididuntut labo.\n2. Re etd olorema gnaaliqu al OREm ipsum do lor sitam ~24 etcon; sect etu radipiscinge li tseddoei.\n3. Usmo dtempori nci diduntu, tlabo REE tdolo; rema gna aliqualore mipsu mdol ors ITA me tconsectetu.\n4. Ra DIP, iscing e litsed doeiu smo dtempori ncididun tutl-Ab or e etdolo remagn aaliqu alor emipsumd ol orsit AME.\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Tco nsectet ur adipisci ngelit se ddoe iusmodt: emporin cid idu ntutlaboree tdolorem agnaaliq ua l ORE-mipsu mdolors itame tconsecteturad ip iscinge litse, dd oeius MOD temp orinc idid untu tla bore etd olorema gn aaliqualo — remips umd olor si tame tconsect et u radipiscinge litse.',
        state: 'done',
      },
    ],
  },
  {
    answer: 'answer 3',
    oneBlock: [
      {
        type: 'text',
        text: '## Lorem ipsumd\n\nOlo r sita metcon sec t 75-etur-adi. Pi scing e litsed, doeiusm, odt emp orincididuntutl abor eetdol or emag naa liqua lo rem ipsumdol orsitametcons — ect etur ad ipi s "cinge lit, seddo" eius mo dtem po rin ci didun tu tlabo\'r ee tdoloremagn.\n\n## Aali qu alor emi psumd?\n\nOl or sitametc onsectetu ra dipi. Sc i ngelitsedd oeiusm od TEM porin cidi du ntutla ≥65, boreetdoloremag naaliqual oremipsu mdo lorsita metconsect, etu rad ipis cingel itsed doe iusm odt emporinc id id untutla bore etdolorema. Gnaaliqua loremips umdolor, sit AME tconsecteturad ipi scin gelitsed do eiusm-odte mporin cid iduntut labore. Etd oloremagn, aal iqualor emips umdol-ors itam et 50 co ns ectetur.\n\n## Adip isc ingelits eddo eiusm odtemporincidid untu\n\n- **Tlabo REE tdolorem ag naa liqualo re mips umdolorsit, am etc onsec.** T 93-etur-adi piscingel i tseddoe iusmodtemporinc ididuntut (laboreetd, oloremagnaa, liqualore, mip sumd) olorsi 20 tametco ns ecteturadipi scingelitseddoe iusmo dt e "mpori ncididuntu"; tla boreetd oloremag na aliqual o remi psum do lorsitametconse ctetura dipisci ng elit seddoeiusm. O 76-dtem-por inci didun tutlabor eet DOL oremagn aal iqualorem ipsumdolorsitam etconsec tetur 200 ad.\n- **Ipiscinge litseddo eiusmodtemp orincididunt:** utlaboreetdolor, E-magna ali qualoremipsumdo lor sitam etc onse ct eturadipi scingelits, eddoe ius modtempor in cididuntu tlaboree.\n- **Tdoloremag naaliqua lor emipsumd:** ol ors Itame Tconsec te Turadip iscing, elitse ddoeiusmod temporincididun tut lab oreetdolor emag naaliqual oremipsu mdol, orsi t amet-consecte turadi 10-pisc ingel itseddoeiusm odtem porin. Cid ID UNtutlabo reetdo lore-magnaal iqual oremi psu mdol orsitamet co nsecte tur adipis cingelitseddoeiu, smod tem porinci diduntut laboreet dolorema gna aliqual orem. Ip sum Dolors 3-I tametc, onsecte turadi piscin gelitseddoeiusm odtem por incididun tutl ab oreetdolo remagna ali qualorem, ipsu mdol or sitametcon secte tur adi pi scing eli tseddoe.\n- **Iusmodtempor incididun tu:** tlab oree tdoloremag naaliqualoremip sumdolor, sitametc/Onsectetu radipisci ngel it s eddoeius modtemp. Orin cididun tutlabo r 75-eetd-olo re magna aliqual or emipsumdol, orsitametcons, ecteturadip, is ci ngelitseddoei — usmodtemporinci didunt ut lab oreetdolo remagnaa liqualo remip sumdo lorsi\' tametconsectetu radipis ci ngelit (SE = 1).\n- **Ddoeiu sm odtempori:** nci Diduntut labore et doloremagnaaliq ualore mi p sumdolorsi tametc onsec tet uradipis cin gelitsedd. Oe iusm od t emporinci, diduntutla, boreetdolore magnaali qual oremip sumd o lorsit ametco nse.\n\n## Ctet U\'r ad\n\n1. Ipisc-inge: LIT-S edd oeius modtemp; orinci did untutlab, oree, TDO, loremagnaa, liqualor/emipsum, dol orsitame tcon secte turadip is cin gel.\n2. It s eddo ei usmodt: emp-orin cididun tu tla boree tdol oremagnaal iqualore mip s umdolorsi tametco-nsecte turadip is cin gelitse; DDO-eiusmodt emporincidid untu tlaboreet dolo remagna aliqualore, mipsumd, olorsitam etc onsectetura.\n3. Di pis cingeli ts eddoeiusmodtemp: orinc idi duntutla, BOR/eetdolo remagnaal, iqualoremips, umdolors itametcon secteturad ip iscingel itse, ddo eiusm odtemporincidid untutl; aboreet dolor emag-naaliqu aloremipsu mdo lorsi; tame tc on secteturad, ipisc-inge lit sedd — oei usmodtem por incididunt.\n\nUtl aboree td ol ore: mag NAA liqua\'l ore "mip s umdolo rsitam etc" onsectet ura dip iscinge litsedd oe iusmo dtempori, nc idi dunt-utlabore etdolore magna aliq ua lor emips, umdolo rsi tame tconsectet uradip isci ngeli tsed.',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-16',
              url: 'https://example.org/source-11',
              title: 'Source 11',
            },
            startIndex: 324,
            endIndex: 437,
            citedText:
              'Loremipsumdolor sit a metconsectetu radipiscing elitsedd oe iusmodte mpo rincidid un tutlab or eetdolorem',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-16',
              url: 'https://example.org/source-11',
              title: 'Source 11',
            },
            startIndex: 439,
            endIndex: 516,
            citedText:
              'lorem ips umdo lor sitamet cons ectetur adi pis ci ngel-its-eddoeiu smodt empo ri ncidi 65 duntu tl abo ree tdolo rema gnaaliq ualoremi',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-17',
              url: 'https://example.org/source-12',
              title: 'Source 12',
            },
            startIndex: 518,
            endIndex: 626,
            citedText:
              'Lore-mip-sumdolo rsitametconsec tet urad i pisc ing elits-eddo eiusmodt emporinci di duntutl aboree, tdo loremagna aliqualo remipsu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-18',
              url: 'https://example.org/source-13',
              title: 'Source 13',
            },
            startIndex: 628,
            endIndex: 695,
            citedText: 'Lor emipsumdo lorsi-tam etcons ec 50 te tu radipis',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-19',
              url: 'https://example.org/source-14',
              title: 'Source 14',
            },
            startIndex: 826,
            endIndex: 1011,
            citedText:
              'Loremi 20 psumdol or sitametconsect, etu radipis cingelits eddoeiusm, odtemporinc, ididunt utlabo, ree tdo lore, magnaaliqu alor e mipsumd olorsitametcons ecteturad',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-19',
              url: 'https://example.org/source-14',
              title: 'Source 14',
            },
            startIndex: 1013,
            endIndex: 1110,
            citedText:
              'Loremipsumdolor sit am etconsecte tura d ipis cingelits ed doeiusmodtempor incidid untutla, boreetdolo re mag naaliqu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-20',
              url: 'https://example.org/source-15',
              title: 'Source 15',
            },
            startIndex: 1112,
            endIndex: 1213,
            citedText:
              'lo remips umdo lorsit ametconsectetur adipisci, ngelitsed DOE-iusmodt, emp o rincididu ntutla bo ree tdolo rema',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-21',
              url: 'https://example.org/source-16',
              title: 'Source 16',
            },
            startIndex: 1217,
            endIndex: 1396,
            citedText:
              'Lor em ipsumdolorsitam, etconsecteturadip iscingeli, tse ddoeiusmodtempo rin cid iduntutla bo reetdolo rema gn aaliqualo remi ps umdolorsi tametconse, ctetu, rad ipiscinge li tsed doeiusm odtemporin',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-22',
              url: 'https://example.org/source-17',
              title: 'Source 17',
            },
            startIndex: 1400,
            endIndex: 1559,
            citedText:
              'Loremi psumdolors itametconsectet ura di piscingeli tsed do eiusmodte mpor inc ididuntu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-23',
              url: 'https://example.org/source-18',
              title: 'Source 18',
            },
            startIndex: 1629,
            endIndex: 1796,
            citedText:
              'Loremips um dolorsi tamet co nsecte turadipiscingel itsed do eiusmodtem pori nc ididuntut labo re etdolore',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-24',
              url: 'https://example.org/source-19',
              title: 'Source 19',
            },
            startIndex: 1798,
            endIndex: 1980,
            citedText:
              'Loremip sumdol orsita metconsectetura dipis cing el itseddoei usmo dte mporincid iduntut lab oreetdol',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-25',
              url: 'https://example.org/source-20',
              title: 'Source 20',
            },
            startIndex: 1984,
            endIndex: 2117,
            citedText:
              "lorem ips u mdolo-rsit ametcons ec tet uradipisc inge li tseddoei/Usmodtemp'o rincidi",
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-26',
              url: 'https://example.org/source-21',
              title: 'Source 21',
            },
            startIndex: 2119,
            endIndex: 2354,
            citedText:
              'Loremipsumdolor (SI=1) tam etco ns ect eturadipi scingeli',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-27',
              url: 'https://example.org/source-22',
              title: 'Source 22',
            },
            startIndex: 2358,
            endIndex: 2484,
            citedText:
              'Lorem ip sum-dolorsita metconse ctet uradi piscin gelitse ddoeiusmo dtemporinc idi dunt utlaboreetd olor emagnaaliqualor emipsum dol or si tametcons ecte tu radipisci ngelits ed doeiusmo',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-17',
              url: 'https://example.org/source-12',
              title: 'Source 12',
            },
            startIndex: 2748,
            endIndex: 2877,
            citedText:
              'Lor-emip sumdolo rsi tame t consec tetu ra dip iscingeli ts eddoeius mo dtempor incididu ntutl abo reetdolorema, gnaaliqual oremipsu, mdo lors it ametconse ctetura dipisci',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-21',
              url: 'https://example.org/source-16',
              title: 'Source 16',
            },
            startIndex: 2879,
            endIndex: 2979,
            citedText:
              'Loremipsumd olorsitametc onsectet ur adi Pisc ing Elit Seddoeiusmodte mporinc ididuntutl, aboreet, doloremag, naa liqualoremi, psumd olor sitam etconsec tet uradip is cingeli tseddoe',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-16',
        url: 'https://example.org/source-11',
        title: 'Source 11',
      },
      {
        type: 'source-url',
        sourceId: 'source-17',
        url: 'https://example.org/source-12',
        title: 'Source 12',
      },
      {
        type: 'source-url',
        sourceId: 'source-18',
        url: 'https://example.org/source-13',
        title: 'Source 13',
      },
      {
        type: 'source-url',
        sourceId: 'source-19',
        url: 'https://example.org/source-14',
        title: 'Source 14',
      },
      {
        type: 'source-url',
        sourceId: 'source-20',
        url: 'https://example.org/source-15',
        title: 'Source 15',
      },
      {
        type: 'source-url',
        sourceId: 'source-21',
        url: 'https://example.org/source-16',
        title: 'Source 16',
      },
      {
        type: 'source-url',
        sourceId: 'source-22',
        url: 'https://example.org/source-17',
        title: 'Source 17',
      },
      {
        type: 'source-url',
        sourceId: 'source-23',
        url: 'https://example.org/source-18',
        title: 'Source 18',
      },
      {
        type: 'source-url',
        sourceId: 'source-24',
        url: 'https://example.org/source-19',
        title: 'Source 19',
      },
      {
        type: 'source-url',
        sourceId: 'source-25',
        url: 'https://example.org/source-20',
        title: 'Source 20',
      },
      {
        type: 'source-url',
        sourceId: 'source-26',
        url: 'https://example.org/source-21',
        title: 'Source 21',
      },
      {
        type: 'source-url',
        sourceId: 'source-27',
        url: 'https://example.org/source-22',
        title: 'Source 22',
      },
    ],
    perParagraph: [
      {
        type: 'text',
        text: '## Lorem ipsumd\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Olo r sita metcon sec t 75-etur-adi. Pi scing e litsed, doeiusm, odt emp orincididuntutl abor eetdol or emag naa liqua lo rem ipsumdol orsitametcons — ect etur ad ipi s "cinge lit, seddo" eius mo dtem po rin ci didun tu tlabo\'r ee tdoloremagn.\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: '## Aali qu alor emi psumd?\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: 'Ol or sitametc onsectetu ra dipi. Sc i ngelitsedd oeiusm od TEM porin cidi du ntutla ≥65, boreetdoloremag naaliqual oremipsu mdo lorsita metconsect, etu rad ipis cingel itsed doe iusm odt emporinc id id untutla bore etdolorema. Gnaaliqua loremips umdolor, sit AME tconsecteturad ipi scin gelitsed do eiusm-odte mporin cid iduntut labore. Etd oloremagn, aal iqualor emips umdol-ors itam et 50 co ns ectetur.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-16',
              url: 'https://example.org/source-11',
              title: 'Source 11',
            },
            startIndex: 34,
            endIndex: 147,
            citedText:
              'Loremipsumdolor sit a metconsectetu radipiscing elitsedd oe iusmodte mpo rincidid un tutlab or eetdolorem',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-16',
              url: 'https://example.org/source-11',
              title: 'Source 11',
            },
            startIndex: 149,
            endIndex: 226,
            citedText:
              'lorem ips umdo lor sitamet cons ectetur adi pis ci ngel-its-eddoeiu smodt empo ri ncidi 65 duntu tl abo ree tdolo rema gnaaliq ualoremi',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-17',
              url: 'https://example.org/source-12',
              title: 'Source 12',
            },
            startIndex: 228,
            endIndex: 336,
            citedText:
              'Lore-mip-sumdolo rsitametconsec tet urad i pisc ing elits-eddo eiusmodt emporinci di duntutl aboree, tdo loremagna aliqualo remipsu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-18',
              url: 'https://example.org/source-13',
              title: 'Source 13',
            },
            startIndex: 338,
            endIndex: 405,
            citedText: 'Lor emipsumdo lorsi-tam etcons ec 50 te tu radipis',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-16',
        url: 'https://example.org/source-11',
        title: 'Source 11',
      },
      {
        type: 'source-url',
        sourceId: 'source-17',
        url: 'https://example.org/source-12',
        title: 'Source 12',
      },
      {
        type: 'source-url',
        sourceId: 'source-18',
        url: 'https://example.org/source-13',
        title: 'Source 13',
      },
      {
        type: 'text',
        text: '## Adip isc ingelits eddo eiusm odtemporincidid untu\n\n',
        state: 'done',
      },
      {
        type: 'text',
        text: '- **Tlabo REE tdolorem ag naa liqualo re mips umdolorsit, am etc onsec.** T 93-etur-adi piscingel i tseddoe iusmodtemporinc ididuntut (laboreetd, oloremagnaa, liqualore, mip sumd) olorsi 20 tametco ns ecteturadipi scingelitseddoe iusmo dt e "mpori ncididuntu"; tla boreetd oloremag na aliqual o remi psum do lorsitametconse ctetura dipisci ng elit seddoeiusm. O 76-dtem-por inci didun tutlabor eet DOL oremagn aal iqualorem ipsumdolorsitam etconsec tetur 200 ad.\n- **Ipiscinge litseddo eiusmodtemp orincididunt:** utlaboreetdolor, E-magna ali qualoremipsumdo lor sitam etc onse ct eturadipi scingelits, eddoe ius modtempor in cididuntu tlaboree.\n- **Tdoloremag naaliqua lor emipsumd:** ol ors Itame Tconsec te Turadip iscing, elitse ddoeiusmod temporincididun tut lab oreetdolor emag naaliqual oremipsu mdol, orsi t amet-consecte turadi 10-pisc ingel itseddoeiusm odtem porin. Cid ID UNtutlabo reetdo lore-magnaal iqual oremi psu mdol orsitamet co nsecte tur adipis cingelitseddoeiu, smod tem porinci diduntut laboreet dolorema gna aliqual orem. Ip sum Dolors 3-I tametc, onsecte turadi piscin gelitseddoeiusm odtem por incididun tutl ab oreetdolo remagna ali qualorem, ipsu mdol or sitametcon secte tur adi pi scing eli tseddoe.\n- **Iusmodtempor incididun tu:** tlab oree tdoloremag naaliqualoremip sumdolor, sitametc/Onsectetu radipisci ngel it s eddoeius modtemp. Orin cididun tutlabo r 75-eetd-olo re magna aliqual or emipsumdol, orsitametcons, ecteturadip, is ci ngelitseddoei — usmodtemporinci didunt ut lab oreetdolo remagnaa liqualo remip sumdo lorsi\' tametconsectetu radipis ci ngelit (SE = 1).\n- **Ddoeiu sm odtempori:** nci Diduntut labore et doloremagnaaliq ualore mi p sumdolorsi tametc onsec tet uradipis cin gelitsedd. Oe iusm od t emporinci, diduntutla, boreetdolore magnaali qual oremip sumd o lorsit ametco nse.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-19',
              url: 'https://example.org/source-14',
              title: 'Source 14',
            },
            startIndex: 74,
            endIndex: 259,
            citedText:
              'Loremi 20 psumdol or sitametconsect, etu radipis cingelits eddoeiusm, odtemporinc, ididunt utlabo, ree tdo lore, magnaaliqu alor e mipsumd olorsitametcons ecteturad',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-19',
              url: 'https://example.org/source-14',
              title: 'Source 14',
            },
            startIndex: 261,
            endIndex: 358,
            citedText:
              'Loremipsumdolor sit am etconsecte tura d ipis cingelits ed doeiusmodtempor incidid untutla, boreetdolo re mag naaliqu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-20',
              url: 'https://example.org/source-15',
              title: 'Source 15',
            },
            startIndex: 360,
            endIndex: 461,
            citedText:
              'lo remips umdo lorsit ametconsectetur adipisci, ngelitsed DOE-iusmodt, emp o rincididu ntutla bo ree tdolo rema',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-21',
              url: 'https://example.org/source-16',
              title: 'Source 16',
            },
            startIndex: 465,
            endIndex: 644,
            citedText:
              'Lor em ipsumdolorsitam, etconsecteturadip iscingeli, tse ddoeiusmodtempo rin cid iduntutla bo reetdolo rema gn aaliqualo remi ps umdolorsi tametconse, ctetu, rad ipiscinge li tsed doeiusm odtemporin',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-22',
              url: 'https://example.org/source-17',
              title: 'Source 17',
            },
            startIndex: 648,
            endIndex: 807,
            citedText:
              'Loremi psumdolors itametconsectet ura di piscingeli tsed do eiusmodte mpor inc ididuntu',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-23',
              url: 'https://example.org/source-18',
              title: 'Source 18',
            },
            startIndex: 877,
            endIndex: 1044,
            citedText:
              'Loremips um dolorsi tamet co nsecte turadipiscingel itsed do eiusmodtem pori nc ididuntut labo re etdolore',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-24',
              url: 'https://example.org/source-19',
              title: 'Source 19',
            },
            startIndex: 1046,
            endIndex: 1228,
            citedText:
              'Loremip sumdol orsita metconsectetura dipis cing el itseddoei usmo dte mporincid iduntut lab oreetdol',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-25',
              url: 'https://example.org/source-20',
              title: 'Source 20',
            },
            startIndex: 1232,
            endIndex: 1365,
            citedText:
              "lorem ips u mdolo-rsit ametcons ec tet uradipisc inge li tseddoei/Usmodtemp'o rincidi",
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-26',
              url: 'https://example.org/source-21',
              title: 'Source 21',
            },
            startIndex: 1367,
            endIndex: 1602,
            citedText:
              'Loremipsumdolor (SI=1) tam etco ns ect eturadipi scingeli',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-27',
              url: 'https://example.org/source-22',
              title: 'Source 22',
            },
            startIndex: 1606,
            endIndex: 1732,
            citedText:
              'Lorem ip sum-dolorsita metconse ctet uradi piscin gelitse ddoeiusmo dtemporinc idi dunt utlaboreetd olor emagnaaliqualor emipsum dol or si tametcons ecte tu radipisci ngelits ed doeiusmo',
          },
        ],
      },
      {
        type: 'source-url',
        sourceId: 'source-19',
        url: 'https://example.org/source-14',
        title: 'Source 14',
      },
      {
        type: 'source-url',
        sourceId: 'source-20',
        url: 'https://example.org/source-15',
        title: 'Source 15',
      },
      {
        type: 'source-url',
        sourceId: 'source-21',
        url: 'https://example.org/source-16',
        title: 'Source 16',
      },
      {
        type: 'source-url',
        sourceId: 'source-22',
        url: 'https://example.org/source-17',
        title: 'Source 17',
      },
      {
        type: 'source-url',
        sourceId: 'source-23',
        url: 'https://example.org/source-18',
        title: 'Source 18',
      },
      {
        type: 'source-url',
        sourceId: 'source-24',
        url: 'https://example.org/source-19',
        title: 'Source 19',
      },
      {
        type: 'source-url',
        sourceId: 'source-25',
        url: 'https://example.org/source-20',
        title: 'Source 20',
      },
      {
        type: 'source-url',
        sourceId: 'source-26',
        url: 'https://example.org/source-21',
        title: 'Source 21',
      },
      {
        type: 'source-url',
        sourceId: 'source-27',
        url: 'https://example.org/source-22',
        title: 'Source 22',
      },
      {
        type: 'text',
        text: "## Ctet U'r ad\n\n",
        state: 'done',
      },
      {
        type: 'text',
        text: '1. Ipisc-inge: LIT-S edd oeius modtemp; orinci did untutlab, oree, TDO, loremagnaa, liqualor/emipsum, dol orsitame tcon secte turadip is cin gel.\n2. It s eddo ei usmodt: emp-orin cididun tu tla boree tdol oremagnaal iqualore mip s umdolorsi tametco-nsecte turadip is cin gelitse; DDO-eiusmodt emporincidid untu tlaboreet dolo remagna aliqualore, mipsumd, olorsitam etc onsectetura.\n3. Di pis cingeli ts eddoeiusmodtemp: orinc idi duntutla, BOR/eetdolo remagnaal, iqualoremips, umdolors itametcon secteturad ip iscingel itse, ddo eiusm odtemporincidid untutl; aboreet dolor emag-naaliqu aloremipsu mdo lorsi; tame tc on secteturad, ipisc-inge lit sedd — oei usmodtem por incididunt.\n\n',
        state: 'done',
        citations: [
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-17',
              url: 'https://example.org/source-12',
              title: 'Source 12',
            },
            startIndex: 149,
            endIndex: 278,
            citedText:
              'Lor-emip sumdolo rsi tame t consec tetu ra dip iscingeli ts eddoeius mo dtempor incididu ntutl abo reetdolorema, gnaaliqual oremipsu, mdo lors it ametconse ctetura dipisci',
          },
          {
            source: {
              type: 'source',
              sourceType: 'url',
              id: 'source-21',
              url: 'https://example.org/source-16',
              title: 'Source 16',
            },
            startIndex: 280,
            endIndex: 380,
            citedText:
              'Loremipsumd olorsitametc onsectet ur adi Pisc ing Elit Seddoeiusmodte mporinc ididuntutl, aboreet, doloremag, naa liqualoremi, psumd olor sitam etconsec tet uradip is cingeli tseddoe',
          },
        ],
      },
      {
        type: 'text',
        text: 'Utl aboree td ol ore: mag NAA liqua\'l ore "mip s umdolo rsitam etc" onsectet ura dip iscinge litsedd oe iusmo dtempori, nc idi dunt-utlabore etdolore magna aliq ua lor emips, umdolo rsi tame tconsectet uradip isci ngeli tsed.',
        state: 'done',
      },
    ],
  },
];
