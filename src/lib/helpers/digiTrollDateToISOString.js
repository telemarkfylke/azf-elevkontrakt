const norwegianDateToISO = (str) => {
  if(!/^\d{2}\.\d{2}\.\d{4}$/.test(str)) throw new Error('Bad format dd.MM.yyyy');
  const [dd, mm, yyyy] = str.split('.');
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return date.toISOString(); // e.g. "2022-08-10T00:00:00.000Z"
}

module.exports = {
    norwegianDateToISO
}