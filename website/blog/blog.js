// Shared language toggle + cookie banner for blog pages
(function () {
  let currentLang = localStorage.getItem('md-lang') || 'de'

  function setLang(lang) {
    currentLang = lang
    localStorage.setItem('md-lang', lang)
    document.documentElement.lang = lang
    document.querySelectorAll('.lang-btn').forEach((b, i) =>
      b.classList.toggle('active', (i === 0 && lang === 'de') || (i === 1 && lang === 'en')))
    document.querySelectorAll('[data-de]').forEach(el => {
      const txt = el.getAttribute('data-' + lang)
      if (txt === null) return
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = txt
      else el.innerHTML = txt
    })
    // Cookie banner texts
    const de = lang === 'de'
    const map = ['cb-text', 'cb-mail', 'cb-close']
    map.forEach(id => {
      const elDe = document.getElementById(id + '-de')
      const elEn = document.getElementById(id + '-en')
      if (elDe) elDe.style.display = de ? '' : 'none'
      if (elEn) elEn.style.display = de ? 'none' : ''
    })
    const mail = document.getElementById('cb-mail')
    if (mail) {
      const sub = mail.getAttribute('data-subject-' + lang)
      if (sub) mail.href = 'mailto:hello@mdstage.org?subject=' + encodeURIComponent(sub)
    }
  }

  window.setLang = setLang
  setLang(currentLang)

  // Cookie banner
  const banner = document.getElementById('cookie-banner')
  if (banner) {
    if (localStorage.getItem('cb-closed')) banner.classList.add('hidden')
    const close = document.getElementById('cb-close')
    if (close) close.addEventListener('click', () => {
      banner.classList.add('hidden')
      localStorage.setItem('cb-closed', '1')
    })
    const mail = document.getElementById('cb-mail')
    if (mail) mail.addEventListener('click', () => {
      localStorage.setItem('cb-closed', '1')
      setTimeout(() => banner.classList.add('hidden'), 400)
    })
  }
})()
