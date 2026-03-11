const schoolInfoList = [
  {
    orgNr: 974568098, // Skolen sitt org nummer
    tilgangsgruppe: 'Elev Bamble vgs', // Tilgangsgruppe i arkiv
    officeLocation: 'Bamble videregående skole', // Officelocation som kommer og matcher fra AD (graph)
    primaryLocation: 'Bamble videregående skole', // Dette er navnet som vil bli brukt for å søke etter prosjektet til skolen i arkivet
    xledgerInvoiceCustomString: '411', // "Number" used to identify custom invoice headers in Xledger, this will not work for format SO01b_2 use text string instead at column "BV" - "Header Info"
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Bamble vgs', // This is the text string that will be used in the invoice header info in Xledger for format SO01b_2, column "BV" - "Header Info".
    xledgerSchoolProductNumber: '4111004' // Used in Xledger to identify what school the invoice is for, this is optional and can be used if the school has a specific product number in Xledger that should be used on the invoice.
  },
  {
    orgNr: 974567997,
    tilgangsgruppe: 'Elev Bø vgs',
    officeLocation: 'Bø vidaregåande skule',
    primaryLocation: 'Bø videregående skole',
    xledgerInvoiceCustomString: '413',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Bø vgs',
    xledgerSchoolProductNumber: '4131001'
  },
  {
    orgNr: 974568071,
    tilgangsgruppe: 'Elev Hjalmar Johansen vgs',
    officeLocation: 'Hjalmar Johansen videregående skole',
    primaryLocation: 'Hjalmar Johansen videregående skole',
    xledgerInvoiceCustomString: '415',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Hjalmar Johansen vgs',
    xledgerSchoolProductNumber: '4151003'
  },
  {
    orgNr: 994309153,
    tilgangsgruppe: 'Elev Kompetansebyggeren',
    officeLocation: 'Kompetansebyggeren Vestfold',
    primaryLocation: 'Kompetansebyggeren Vestfold',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Kompetansebyggeren Vestfold',
    xledgerSchoolProductNumber: '111111'
  },
  {
    orgNr: 974568004,
    tilgangsgruppe: 'Elev Kragerø vgs',
    officeLocation: 'Kragerø videregående skole',
    primaryLocation: 'Kragerø videregående skole',
    xledgerInvoiceCustomString: '417',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Kragerø vgs',
    xledgerSchoolProductNumber: '4171003'
  },
  {
    orgNr: 974568187,
    tilgangsgruppe: 'Elev Nome vgs',
    officeLocation: 'Nome videregående skole',
    primaryLocation: 'Nome videregående skole',
    xledgerInvoiceCustomString: '419',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Nome vgs',
    xledgerSchoolProductNumber: '4191017'
  },
  {
    orgNr: 974568012,
    tilgangsgruppe: 'Elev Notodden vgs',
    officeLocation: 'Notodden videregående skole',
    primaryLocation: 'Notodden videregående skole',
    xledgerInvoiceCustomString: '421',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Notodden vgs',
    xledgerSchoolProductNumber: '4211002'
  },
  {
    orgNr: 974568020,
    tilgangsgruppe: 'Elev Porsgrunn vgs',
    officeLocation: 'Porsgrunn videregående skole',
    primaryLocation: 'Porsgrunn videregående skole',
    xledgerInvoiceCustomString: '423',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Porsgrunn vgs',
    xledgerSchoolProductNumber: '4231019'
  },
  {
    orgNr: 874568082,
    tilgangsgruppe: 'Elev Rjukan vgs',
    officeLocation: 'Rjukan videregående skole',
    primaryLocation: 'Rjukan videregående skole',
    xledgerInvoiceCustomString: '425',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Rjukan vgs',
    xledgerSchoolProductNumber: '4251007'
  },
  {
    orgNr: 974568039,
    tilgangsgruppe: 'Elev Skien vgs',
    officeLocation: 'Skien videregående skole',
    primaryLocation: 'Skien videregående skole',
    xledgerInvoiceCustomString: '427',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Skien vgs',
    xledgerSchoolProductNumber: '4271002'
  },
  {
    orgNr: 974568152,
    tilgangsgruppe: 'Elev Skogmo vgs',
    officeLocation: 'Skogmo videregående skole',
    primaryLocation: 'Skogmo videregående skole',
    xledgerInvoiceCustomString: '429',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Skogmo vgs',
    xledgerSchoolProductNumber: '4291014'
  },
  {
    orgNr: 973754815,
    tilgangsgruppe: 'Elev Skolen for sosiale og medisinske institusjoner',
    officeLocation: 'SMI-skolen',
    primaryLocation: 'SMI-skolen',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med SMI-skolen',
    xledgerSchoolProductNumber: '111111'
  },
  {
    orgNr: 974568055,
    tilgangsgruppe: 'Elev Vest-Telemark vgs',
    officeLocation: 'Vest-Telemark vidaregåande skule',
    primaryLocation: 'Vest-Telemark videregående skole',
    xledgerInvoiceCustomString: '431',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Vest-Telemark vgs',
    xledgerSchoolProductNumber: '4311007'
  },
  {
    orgNr: 974568055,
    tilgangsgruppe: 'Elev Vest-Telemark vgs',
    officeLocation: 'Vest-Telemark vgs avd Dalen',
    primaryLocation: 'Vest-Telemark videregående skole',
    xledgerInvoiceCustomString: '431',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Vest-Telemark vgs',
    xledgerSchoolProductNumber: '4311007'
  },
  {
    orgNr: 998151228,
    tilgangsgruppe: '',
    officeLocation: 'Telemark fylkeskommune privatisteksamen',
    primaryLocation: 'Telemark fylkeskommune privatisteksamen',
    xledgerInvoiceCustomString: '465',
    xledgerInvoiceHeaderInfo: 'Spørsmål vedrørende faktura, ta kontakt med Telemark fylkeskommune privatisteksamen',
    xledgerSchoolProductNumber: '111111'
  }
]

module.exports = {
  schoolInfoList
}
