const schoolInfoList = [
  {
    orgNr: 974568098, // Skolen sitt org nummer
    tilgangsgruppe: 'Elev Bamble vgs', // Tilgangsgruppe i arkiv
    officeLocation: 'Bamble videregående skole', // Officelocation som kommer og matcher fra AD (graph)
    primaryLocation: 'Bamble videregående skole', // Dette er navnet som vil bli brukt for å søke etter prosjektet til skolen i arkivet
    xledgerInvoiceCustomString: '4110', // "Number" used to identify custom invoice headers in Xledger, this will not work for format SO01b_2 use text string instead at column "BV" - "Header Info"
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Bamble vgs'

  },
  {
    orgNr: 974567997,
    tilgangsgruppe: 'Elev Bø vgs',
    officeLocation: 'Bø vidaregåande skule',
    primaryLocation: 'Bø videregående skole',
    xledgerInvoiceCustomString: '4130',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Bø vgs'
  },
  {
    orgNr: 974568071,
    tilgangsgruppe: 'Elev Hjalmar Johansen vgs',
    officeLocation: 'Hjalmar Johansen videregående skole',
    primaryLocation: 'Hjalmar Johansen videregående skole',
    xledgerInvoiceCustomString: '4150',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Hjalmar Johansen vgs'
  },
  {
    orgNr: 994309153,
    tilgangsgruppe: 'Elev Kompetansebyggeren',
    officeLocation: 'Kompetansebyggeren Vestfold',
    primaryLocation: 'Kompetansebyggeren Vestfold',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Kompetansebyggeren Vestfold'
  },
  {
    orgNr: 974568004,
    tilgangsgruppe: 'Elev Kragerø vgs',
    officeLocation: 'Kragerø videregående skole',
    primaryLocation: 'Kragerø videregående skole',
    xledgerInvoiceCustomString: '4170',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Kragerø vgs'
  },
  {
    orgNr: 974568187,
    tilgangsgruppe: 'Elev Nome vgs',
    officeLocation: 'Nome videregående skole',
    primaryLocation: 'Nome videregående skole',
    xledgerInvoiceCustomString: '4190',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Nome vgs'
  },
  {
    orgNr: 974568012,
    tilgangsgruppe: 'Elev Notodden vgs',
    officeLocation: 'Notodden videregående skole',
    primaryLocation: 'Notodden videregående skole',
    xledgerInvoiceCustomString: '4210',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Notodden vgs'
  },
  {
    orgNr: 974568020,
    tilgangsgruppe: 'Elev Porsgrunn vgs',
    officeLocation: 'Porsgrunn videregående skole',
    primaryLocation: 'Porsgrunn videregående skole',
    xledgerInvoiceCustomString: '4230',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Porsgrunn vgs'
  },
  {
    orgNr: 874568082,
    tilgangsgruppe: 'Elev Rjukan vgs',
    officeLocation: 'Rjukan videregående skole',
    primaryLocation: 'Rjukan videregående skole',
    xledgerInvoiceCustomString: '4250',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Rjukan vgs'
  },
  {
    orgNr: 974568039,
    tilgangsgruppe: 'Elev Skien vgs',
    officeLocation: 'Skien videregående skole',
    primaryLocation: 'Skien videregående skole',
    xledgerInvoiceCustomString: '4270',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Skien vgs'
  },
  {
    orgNr: 974568152,
    tilgangsgruppe: 'Elev Skogmo vgs',
    officeLocation: 'Skogmo videregående skole',
    primaryLocation: 'Skogmo videregående skole',
    xledgerInvoiceCustomString: '4290',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Skogmo vgs'
  },
  {
    orgNr: 973754815,
    tilgangsgruppe: 'Elev Skolen for sosiale og medisinske institusjoner',
    officeLocation: 'SMI-skolen',
    primaryLocation: 'SMI-skolen',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med SMI-skolen'
  },
  {
    orgNr: 974568055,
    tilgangsgruppe: 'Elev Vest-Telemark vgs',
    officeLocation: 'Vest-Telemark vidaregåande skule',
    primaryLocation: 'Vest-Telemark videregående skole',
    xledgerInvoiceCustomString: '4310',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Vest-Telemark vgs'
  },
  {
    orgNr: 974568055,
    tilgangsgruppe: 'Elev Vest-Telemark vgs',
    officeLocation: 'Vest-Telemark vgs avd Dalen',
    primaryLocation: 'Vest-Telemark videregående skole',
    xledgerInvoiceCustomString: '4310',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Vest-Telemark vgs'
  },
  {
    orgNr: 998151228,
    tilgangsgruppe: '',
    officeLocation: 'Telemark fylkeskommune privatisteksamen',
    primaryLocation: 'Telemark fylkeskommune privatisteksamen',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Telemark fylkeskommune privatisteksamen'
  }
]

module.exports = {
  schoolInfoList
}
