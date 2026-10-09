import { publishedModels } from '../data/published-plans';
import { localTranslationGuides } from './guides/es';
import type { Dictionary } from './types';

const membershipSummary = `La lectura local es gratuita. Free incluye 30 páginas diarias con ${publishedModels.free.join(' · ')}. PLUS: 2.500 páginas al mes, US$6,66 por trimestre o US$23,99 al año. Pro: 4.000 páginas al mes, US$9,99 por trimestre o US$35,99 al año. Ambos incluyen los modelos gratuitos y añaden ${publishedModels.paid_extra.join(' · ')}. Se asignan páginas mensualmente, sin acumulación ni prueba. Paquetes sin caducidad: 3.500 páginas por US$5,99 o 7.000 por US$9,99. Impuestos e importe final al pagar.`;

export default {
  "ui": {
    "seoChangelogTitle": "Notas de versión de la extensión de traducción de manga",
    "seoAboutTitle": "Acerca de nuestro traductor de manga y lector de cómics",
    "seoHelpTitle": "Ayuda con la traducción de manga y la extensión",
    "seoFaqTitle": "Preguntas frecuentes sobre traducción de manga: instalación, archivos y límites",
    "seoGuidesTitle": "Guías de traducción, EPUB, OPDS y lectura sin conexión",
    "features": "Funciones",
    "pricing": "Precios",
    "guides": "Guías",
    "help": "Ayuda",
    "account": "Mi cuenta",
    "download": "Obtener la extensión",
    "faq": "FAQ",
    "about": "Acerca de NodeLane Comics",
    "changelog": "Registro de cambios",
    "privacy": "Política de privacidad",
    "terms": "Términos de servicio",
    "refund": "Suscripciones y reembolsos",
    "home": "Inicio",
    "skip": "Saltar al contenido",
    "navigation": "Navegación principal",
    "mobileNavigation": "Navegación móvil",
    "menu": "Abrir navegación",
    "language": "Idioma",
    "tagline": "Buenas historias, más allá del lenguaje.",
    "footerStory": "Encuentra historias, retoma la lectura y traduce las imágenes cuando lo necesites.",
    "startReading": "Empezar a leer",
    "support": "Soporte de lector",
    "company": "Sobre nosotros",
    "copyright": "Hecho para personas que aman las historias.",
    "artNote": "Capturas de pantalla del producto e ilustraciones originales de IA · Las ilustraciones del cómic pertenecen a sus respectivos dueños",
    "ogAlt": "Ilustración original de manga junto al mar NodeLane Comics",
    "heroTitle": "Tus mangas. Tu ritmo. Tu idioma.",
    "heroDescription": "Lee y traduce en Chrome, Edge y Firefox: archivos locales, EPUB, Google Drive, bibliotecas OPDS y sitios compatibles. Descubre manga, compara los originales y prepara tu lectura sin conexión.",
    "heroEyebrow": "TU PRÓXIMA PÁGINA, EN TU IDIOMA",
    "freeStart": "Empieza a leer gratis",
    "seeHow": "Mira como funciona",
    "desktop": "Para navegadores de escritorio",
    "heroCaption": "Arte original de IA para NodeLane Comics",
    "heroAlt": "Manga original: un viajero espera en un andén de ferrocarril junto al mar",
    "nextStop": "PRÓXIMA PARADA / UN MUNDO NUEVO",
    "featureHeading": "Descubre, lee y traduce a tu ritmo.",
    "featureDescription": "Importa archivos, abre una biblioteca OPDS o añade un manga de un sitio compatible. Retoma tu progreso, compara originales y traducciones y guarda capítulos para leer sin conexión.",
    "featureTitles": [
      "Archivos locales y EPUB",
      "Bibliotecas OPDS",
      "Descubrimiento y búsqueda entre sitios",
      "Traducción en la página y de áreas",
      "Servicio oficial o manga-translator-ui",
      "Lectura sin conexión y ajustes"
    ],
    "featureBodies": [
      "Importa CBZ/ZIP, CBR/RAR, PDF, MOBI o EPUB sin DRM. Lee originales localmente; EPUB solo traduce las imágenes de mapa de bits integradas.",
      "Conecta varias bibliotecas OPDS para explorar, buscar y leer bajo demanda. Si un recurso permite leer de forma fiable mediante rangos HTTP, solo se obtienen las partes necesarias; en caso contrario, se requiere una descarga completa explícita.",
      "Explora tendencias, novedades y clasificaciones de AniList. Busca un título, alias o nombre traducido en sitios compatibles y comprueba la fuente antes de añadirla.",
      "Traduce la página, una imagen con clic derecho o un rectángulo visible. La selección no desplaza la página para unir una imagen larga. Personaliza los atajos en el navegador.",
      "Traducción clásica, vuelta al original y comparación en paralelo. Elige el servicio oficial con tu cuenta o tu propio manga-translator-ui sin cuota oficial.",
      "Guarda capítulos, pausa, continúa y completa las páginas que faltan. Ajusta la lectura continua o por páginas, la dirección, el zoom y el fondo."
    ],
    "ribbon": [
      "Archivos, EPUB y OPDS",
      "Traducción clásica",
      "Originales y comparación",
      "Capítulos guardados sin conexión"
    ],
    "compareTitle": "Comprender el diálogo. Mantén el sentimiento.",
    "compareDescription": "No saltes entre tu manga y una ventana de traducción. Vuelve a poner palabras en la imagen y quédate con los personajes.",
    "readingTitle": "Tu colección. Una nueva forma de leer.",
    "readingDescription": "Importa archivos, abre una biblioteca OPDS o añade un manga de un sitio compatible. Retoma tu progreso, compara originales y traducciones y guarda capítulos para leer sin conexión.",
    "readingAlt": "Ilustración original de un manga abierto junto a una ventana con vistas al mar.",
    "guideHeading": "Algunas notas antes de la página siguiente.",
    "allGuides": "Todas las guías de lectura",
    "readGuide": "Leer guía",
    "minutes": "min",
    "ctaTitle": "Las buenas historias merecen ser comprendidas.",
    "ctaDescription": "Abre una historia que tengas derecho a leer. Traduce cuando quieras y conserva el original a mano.",
    "ctaButton": "Comienza tu viaje de lectura",
    "pricingTitle": "Leer gratis. Elige tu plan de traducción.",
    "pricingDescription": "PLUS / Pro y paquetes sin caducidad. Pago trimestral o anual, páginas cada mes. Sin prueba de suscripción.",
    "freePlan": "Gratis",
    "freePlanDescription": "Para leer un poco todos los días.",
    "free": "gratis",
    "month": "mes",
    "freeBenefits": [
      "30 páginas de traducción clásica por día",
      "Lectura de cómics web y locales.",
      "Comparación con el original y conservación de la posición de lectura",
      "Acceso a sus resultados existentes válidos",
      "Hasta 10 nuevas imágenes de traducción cada 60 segundos consecutivos"
    ],
    "freeNote": "Las páginas diarias se restablecen según la hora de Asia/Shanghai y las no utilizadas no se acumulan.",
    "quotaNote": "Cada versión generada correctamente de una imagen en el modo y el idioma elegidos cuenta como una página. Las solicitudes duplicadas y la reutilización de resultados válidos no se cobran dos veces. Una nueva traducción solicitada expresamente utiliza los beneficios actuales. Se aplican límites de frecuencia, dimensiones de imagen y capacidad del servicio; no se garantiza una velocidad de finalización.",
    "downloadTitle": "Instala tu extensión de traductor de manga",
    "downloadDescription": "Obtén NodeLane Comics para Chrome, Edge o Firefox. Abre Chrome Web Store, Edge Add-ons o Firefox Add-ons, o descarga el paquete correspondiente a tu navegador.",
    "storeDescription": "Abre tu próxima historia en el navegador que ya disfrutas.",
    "storeUnavailable": "Pendiente de revisión en la tienda",
    "directDownloadTitle": "Descarga la extensión directamente",
    "directDownloadDescription": "Descargue el paquete de la tarjeta de su navegador, extráigalo y luego siga estos pasos.",
    "packageUnavailable": "Descarga del paquete no disponible",
    "downloadZip": "Descargar ZIP",
    "installTitle": "Instalación manual para Chrome / Edge",
    "installStepDownload": "Descargue y extraiga el ZIP. Conserve la carpeta extraída.",
    "installStepBrowser": "Abra chrome://extensions (Chrome) o edge://extensions (Edge) en la barra de direcciones y active el modo Desarrollador.",
    "installStepLoad": "Haga clic en Cargar descomprimido, seleccione la carpeta que contiene manifest.json y luego fije la extensión a su barra de herramientas.",
    "manualUpdateNote": "Las instalaciones manuales no se actualizan automáticamente. Descargue la nueva versión, reemplace los archivos en la carpeta original y luego haga clic en Recargar en la página de extensiones. Mantenga la carpeta de instalación en su lugar.",
    "downloadXpi": "Descargar firmado XPI",
    "storeHeading": "Enlaces a la tienda del navegador",
    "storeNote": "Instala desde la tienda oficial de Chrome, Edge o Firefox, o usa el paquete correspondiente a tu navegador. Comentarios:",
    "guidesTitle": "Guías de traducción, EPUB, OPDS y lectura sin conexión",
    "guidesDescription": "Importa CBZ, CBR, PDF, MOBI y EPUB, conecta bibliotecas OPDS, traduce imágenes o un área visible y prepara tu lectura sin conexión. Compara los originales y elige tu servicio.",
    "contents": "En esta página",
    "editor": "NodeLane Comics equipo editorial",
    "updated": "Actualizado",
    "related": "Leer siguiente",
    "faqTitle": "Preguntas frecuentes sobre la extensión del traductor de manga",
    "faqDescription": "Respuestas sobre instalación, archivos locales y EPUB, Google Drive, OPDS, traducción de áreas, lectura sin conexión, servicios de traducción y privacidad.",
    "helpTitle": "Ayuda con traducción y extensión de manga",
    "helpDescription": "Ayuda para importar archivos, conectar OPDS, acceder a imágenes de sitios, traducir áreas y revisar permisos y conexiones al servicio de traducción.",
    "contactTitle": "Cada comentario merece una lectura atenta.",
    "videoTutorials": "Videotutoriales",
    "githubSource": "Ver fuente en GitHub",
    "youtubeDescription": "Vea demostraciones de productos en el canal NodeLane YouTube para aprender cómo buscar, importar, almacenar en caché y traducir cómics.",
    "watchVideos": "Visita nuestro canal YouTube",
    "contactDescription": "Utilice la opción de comentarios por página en la extensión para comprobar la calidad de la traducción. Para otros problemas, envíenos un correo electrónico con su navegador, versión de extensión, pasos y mensaje de error. No envíe contraseñas, tokens, datos de tarjetas de pago, URL firmadas ni cómics completos que no tenga derecho a compartir.",
    "emailButton": "enviar un correo electrónico",
    "aboutTitle": "Acerca de NodeLane Comics",
    "aboutDescription": "Una extensión para descubrir, leer y traducir manga: archivos locales, EPUB, Drive, OPDS y sitios compatibles. La web también ofrece un espacio de traducción de imágenes.",
    "aboutBody": "NodeLane Comics reúne descubrimiento, búsqueda entre sitios, lectura y traducción clásica en una extensión para Chrome, Edge y Firefox. Importa archivos locales, conecta Google Drive o varias bibliotecas OPDS y lee sitios compatibles. Compara las imágenes originales, conserva tu posición y prepara capítulos para leer sin conexión. Elige el servicio oficial o tu propio manga-translator-ui. La web dispone de un espacio independiente para traducir imágenes. No ofrecemos un catálogo de manga ni eludimos inicios de sesión, muros de pago o DRM. Utiliza solo contenido que tengas derecho a leer y procesar.",
    "changelogTitle": "NodeLane Comics notas de la versión",
    "changelogDescription": "Siga las actualizaciones del traductor de manga, soporte para nuevos sitios, compatibilidad del navegador y correcciones de lectura. Las aprobaciones de las tiendas Chrome, Edge y Firefox pueden diferir; verifique su versión instalada.",
    "rss": "Siga las actualizaciones vía RSS",
    "accountTitle": "Mi cuenta",
    "accountDescription": "Gestiona tu cuenta y tu suscripción. La traducción de imágenes del sitio web y la extensión comparten el cupo de tu cuenta.",
    "callbackTitle": "Abriendo su pase de lector.",
    "callbackDescription": "Volverá a su cuenta cuando se complete el inicio de sesión.",
    "noscript": "Se requiere JavaScript para iniciar sesión en la cuenta. Las páginas de productos, precios y guías funcionan sin él.",
    "seoHomeTitle": "Traductor de manga y lector EPUB, OPDS | NodeLane Comics",
    "heroLines": [
      "Tus mangas. Tu ritmo.",
      "Tu idioma."
    ],
    "seoFeaturesTitle": "Funciones de traducción de manga y lector de cómics",
    "seoPricingTitle": "Traducción manga gratuita y planes PLUS / Pro",
    "seoDownloadTitle": "Traductor de manga para Chrome, Edge y Firefox",
    "brandName": "NodeLane Comics",
    "notFoundTitle": "Una página demasiado lejos.",
    "notFoundDescription": "Esta página no existe o su dirección ha cambiado. Tu próxima historia todavía está esperando en la página de inicio."
  },
  "documents": {
    "guides": [
{
  "slug": "manga-translation",
  "minutes": 4,
  "title": "Cómo traducir manga en tu navegador",
  "description": "Traduce imágenes de la página, una imagen con clic derecho o un área visible. Usa el lector en sitios compatibles, elige un servicio y compara con los originales.",
  "category": "Empezando",
  "sections": [
    {
      "title": "Por qué la traducción de imágenes es diferente",
      "paragraphs": [
        "La traducción normal del navegador maneja el texto de la página web. Los diálogos manga suelen ser parte de una imagen, por lo que necesitan procesamiento de imágenes y colocación de texto. NodeLane Comics combina traducción y un lector en una sola extensión.",
        "Instálelo a través de la tienda del navegador correspondiente, fije la extensión y abra un cómic al que tenga derecho a acceder. El sitio web y la extensión utilizan el mismo servicio de identidad y beneficios de cuenta."
      ]
    },
    {
      "title": "La página, una imagen o un área visible",
      "paragraphs": [
        "En un sitio con adaptador, abre el lector o importa el manga. En otras páginas, usa la traducción de la página, el clic derecho sobre una imagen o la selección de un rectángulo visible. La selección no desplaza la página para unir una captura larga. Las páginas sin adaptador no se importan a la biblioteca. Configura los atajos en los ajustes nativos del navegador.",
        "Los mangas nuevos se abren con los originales y la traducción automática está desactivada por defecto. Actívala cuando la necesites: se procesa la página actual y una ventana limitada de imágenes cercanas. Los resultados y los cambios de vista conservan la posición; una página fallida no bloquea las demás."
      ]
    },
    {
      "title": "Mantenga el original cerca",
      "paragraphs": [
        "Cuando llega una traducción, se conserva su posición de lectura. Cambie al original para diálogos poco claros, texto pequeño o efectos de sonido. La IA puede omitir o malinterpretar el contenido; La redacción fluida no es prueba de exactitud.",
        "Una página fallida no bloquea a las demás. Utilice comentarios por página cuando algo anda mal. Solicitar explícitamente una nueva traducción crea una nueva versión y utiliza el derecho correspondiente."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "translation-modes",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 5,
  "title": "Traducción clásica: ¿servicio oficial o manga-translator-ui?",
  "description": "Conoce la traducción clásica de la extensión, elige el servicio oficial o tu propio MTU y distingue las funciones del espacio web de traducción de imágenes.",
  "category": "Consejos de traducción",
  "sections": [
    {
      "title": "Traducción clásica en la extensión",
      "paragraphs": [
        "La extensión ofrece traducción clásica: detección de texto, reconocimiento OCR, traducción, borrado y colocación del texto. Puedes volver al original o comparar las imágenes en paralelo.",
        "El reconocimiento y la traducción pueden omitir palabras o interpretar mal nombres, efectos de sonido y contexto. Comprueba también la disposición del texto. Compara varias páginas representativas con los originales; una redacción fluida no garantiza precisión."
      ]
    },
    {
      "title": "Servicio oficial de NodeLane",
      "paragraphs": [
        "Inicia sesión en NodeLane para usar el servicio oficial. Las imágenes seleccionadas se procesan a distancia según los derechos y límites mostrados en tu cuenta. Los resultados válidos pueden reutilizarse según las reglas de conservación.",
        membershipSummary
      ]
    },
    {
      "title": "El espacio web de traducción de imágenes",
      "paragraphs": [
        "La web acepta JPG, PNG y WebP, con una prueba para invitados o la cuota de tu cuenta.",
        "Compara el texto traducido con el original. Los resultados se guardan por idioma y siguen las reglas de acceso, conservación y facturación indicadas en el espacio web."
      ]
    },
    {
      "title": "Tu servicio manga-translator-ui",
      "paragraphs": [
        "Añade tu servicio manga-translator-ui en los ajustes y selecciónalo para la traducción clásica. Puedes guardar varios perfiles; solo se utiliza uno a la vez. No necesitas cuenta NodeLane ni cuota oficial. La contraseña y el token de MTU se guardan en este equipo. El procesamiento, los costes de modelos y los requisitos de red dependen de tu servicio; un MTU local no garantiza una traducción totalmente sin conexión. Guardar la contraseña y reconectar con el campo vacío requiere la extensión 0.10.2 o posterior; en versiones anteriores debes introducirla en cada reconexión."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "local-comics",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 5,
  "title": "Leer archivos CBZ, CBR, PDF, MOBI y EPUB",
  "description": "Formatos locales compatibles, importación, lectura de MOBI y EPUB sin DRM y límites de traducción de imágenes integradas.",
  "category": "Lectura local",
  "sections": [
    {
      "title": "Conozca el formato del archivo",
      "paragraphs": [
        "CBZ normalmente empaqueta imágenes en ZIP; CBR usa RAR. Se deben representar PDF páginas y MOBI contiene registros de libros y referencias de imágenes. Cambiar una extensión no convierte un archivo.",
        "Importa archivos compatibles CBZ/ZIP, CBR/RAR, PDF y MOBI o EPUB sin DRM. EPUB conserva la lectura del documento; solo se traducen sus imágenes de mapa de bits integradas, no el texto del libro ni los elementos vectoriales. No se importan imágenes sueltas, archivos KF8/AZW3 independientes ni libros cifrados. Los sitios necesitan un adaptador dedicado."
      ]
    },
    {
      "title": "comprobar la importación",
      "paragraphs": [
        "Utilice un expediente completo que tenga derecho a procesar. Compruebe si hay contraseñas, daños o compresión no compatible. Después de la importación, verifique las portadas, el orden de los capítulos, las miniaturas y la claridad de la imagen.",
        "La importación y la lectura de originales se realizan en el navegador sin cuenta NodeLane. La traducción oficial envía las imágenes seleccionadas al servicio; el canal MTU las envía a tu servidor. El almacenamiento local no garantiza traducción sin conexión ni sincroniza toda la biblioteca."
      ]
    },
    {
      "title": "MOBI y EPUB: leer el libro y traducir las imágenes",
      "paragraphs": [
        "Las importaciones MOBI están limitadas a 512 MB y 1500 páginas y deben pasar controles estructurales. Las referencias de imágenes corporales admitidas determinan el orden; El HTML del libro no se ejecuta. Los GIF incrustados se pueden leer, pero la traducción utiliza un primer fotograma normalizado. DRM no se elimina.",
        "Los EPUB sin DRM conservan el texto y la navegación del documento. Solo se traducen las imágenes de mapa de bits incluidas en el libro, manteniendo sus originales disponibles. No se traduce el texto del documento ni los elementos vectoriales y no se elimina el DRM. Comprueba el orden de lectura, la navegación y las imágenes tras importar."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "japanese-manga",
  "minutes": 4,
  "title": "¿Por qué comparar las traducciones del manga japonés con el original?",
  "description": "Lea diálogos verticales, temas implícitos y efectos de sonido con más contexto y menos malentendidos.",
  "category": "leyendo juntos",
  "sections": [
    {
      "title": "El contexto importa",
      "paragraphs": [
        "El manga japonés a menudo omite temas y transmite relaciones a través de formas de dirección y finales de oraciones. Es posible que una sola burbuja de diálogo no proporcione suficiente contexto a un modelo. Una oración fluida aún puede identificar erróneamente a un hablante o una emoción.",
        "Si una relación o causa de repente parece extraña, compare los paneles originales y los vecinos antes de considerar la traducción como definitiva."
      ]
    },
    {
      "title": "Esté atento a los mensajes de texto perdidos",
      "paragraphs": [
        "La escritura vertical, el diálogo entre paneles y los efectos de sonido incrustados en los fondos son difíciles de detectar. La escritura pequeña, el ruido y la baja resolución pueden empeorar el reconocimiento.",
        "Utilice un original claro que tenga permiso para procesar. Preste atención a los avisos de resultados parciales. Primero lea la página traducida, luego compare los nombres o pronombres poco claros con el original, los personajes y los paneles anteriores."
      ]
    },
    {
      "title": "Comprueba tanto palabras como imágenes.",
      "paragraphs": [
        "El reconocimiento y la traducción pueden omitir palabras o interpretar mal nombres, efectos de sonido y contexto. Comprueba también la disposición del texto. Compara varias páginas representativas con los originales; una redacción fluida no garantiza precisión.",
        "NodeLane Comics mantiene el original disponible. La traducción reduce la barrera a la comprensión sin quitar la capacidad de verificar el trabajo en sí."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "translation-troubleshooting",
  "related": [
    "local-translation",
    "local-manga-translator",
    "manga-translation"
  ],
  "minutes": 4,
  "title": "¿La traducción del manga falló o sigue esperando?",
  "description": "Distinga la recuperación de imágenes, el acceso a cuentas, los trabajos fallidos y los resultados desconocidos antes de volver a intentarlo.",
  "category": "Solución de problemas",
  "sections": [
    {
      "title": "Identificar el escenario",
      "paragraphs": [
        "Una imagen que no se pudo recuperar, una tarea enviada que aún se está procesando y una traducción explícitamente fallida son estados diferentes. Lea primero el mensaje de la página. Una página problemática no bloquea a las demás.",
        "Para problemas de recuperación, confirme que la imagen se abre normalmente en el sitio de origen y verifique los permisos del sitio/CDN. La carga diferida, la navegación o las restricciones de fuente pueden afectar el acceso."
      ]
    },
    {
      "title": "Resuelva la tarea original primero.",
      "paragraphs": [
        "Las tareas oficiales persisten en el servidor. Cerrar la página o perder brevemente la conexión no las elimina. Tras reconectar, deja que la extensión recupere el estado de la tarea; para MTU, comprueba directamente tu servicio antes de reintentar.",
        "Lee el mensaje de la página y comprueba la imagen, el idioma y el servicio seleccionado. Una nueva traducción solicitada expresamente crea otra versión según las reglas del servicio. Reintenta después de corregir la causa; enviar repetidamente no confirma el estado de una tarea."
      ]
    },
    {
      "title": "Verificar acceso e informar claramente",
      "paragraphs": [
        "Inicie sesión nuevamente si la autorización expiró, verifique la lista de idiomas del modo y verifique la asignación actual o el vencimiento de la promoción. El fallo explícito libera la reserva relacionada.",
        "Informe su navegador, versión de extensión, pasos, mensaje de error y una identificación de tarea si está disponible. Utilice únicamente las capturas de pantalla censuradas y necesarias. Nunca envíe cookies de origen, tokens o URL de imágenes firmadas. Póngase en contacto con comics@nodelane.net."
      ]
    }
  ],
  "updated": "2026-10-04"
},
{
  "slug": "comic-reader-privacy",
  "minutes": 4,
  "title": "¿Qué carga una extensión de traducción de manga?",
  "description": "Comprenda los permisos del sitio web, el análisis local, la carga de traducciones, los originales temporales, los resultados privados y la eliminación.",
  "category": "guía de privacidad",
  "sections": [
    {
      "title": "Permisos y archivos locales",
      "paragraphs": [
        "La extensión declara durante la instalación el acceso a todos los sitios y dominios de imágenes HTTP/HTTPS, sin solicitar permisos por sitio o dominio durante el uso. Puedes limitar el acceso en los ajustes de extensiones del navegador; si alguna función deja de funcionar, restablece el acceso a todos los sitios y vuelve a intentarlo. Las cookies y los tokens de inicio de sesión del sitio de origen y el historial de navegación no se envían al servicio oficial de traducción. Solo se procesan las imágenes seleccionadas y los datos necesarios para la tarea.",
        "El análisis de cómics local se realiza en el navegador. Poner un archivo en su estante local no significa cargar el archivo fuente completo. Cuando se necesita traducción, se envían imágenes de páginas relevantes e información de tareas."
      ]
    },
    {
      "title": "Traducción y retención",
      "paragraphs": [
        "La extensión actual solo ofrece traducción clásica. La traducción clásica utiliza reconocimiento, traducción de texto, limpieza y composición tipográfica. Los originales son archivos temporales en el servidor central y en los nodos de computación, que se eliminan después de que una tarea se completa, falla o se cancela. La traducción clásica mantiene archivos superpuestos. Los resultados permanecen privados mientras su cuenta tenga una solicitud válida. El texto reconocido, las traducciones y los metadatos necesarios se almacenan en la base de datos.",
        "Los resultados se reutilizan solo dentro de la misma cuenta cuando el contenido, el modo, el idioma y la configuración efectiva coinciden y permanece una solicitud válida. Los originales y los resultados no se comparten entre los usuarios. El navegador combina superposiciones con su propia imagen original; el servidor no guarda copias originales permanentes."
      ]
    },
    {
      "title": "¿Qué significa la eliminación?",
      "paragraphs": [
        "La eliminación de un registro de traducción revoca inmediatamente el acceso al servidor de esa solicitud. Otras solicitudes válidas en su cuenta siguen siendo utilizables; el archivo de resultados se elimina después de revocar la última solicitud válida. Las copias descargadas o almacenadas en caché pueden permanecer en su dispositivo hasta que las borre.",
        "Para solicitudes de acceso, corrección o eliminación, comuníquese con comics@nodelane.net. Se debe verificar la identidad y el alcance antes de manejar los datos de otra persona. Lea la política de privacidad completa para más detalles."
      ]
    }
  ],
  "updated": "2026-10-08"
},
{
  "slug": "remote-library",
  "title": "Bibliotecas OPDS, EPUB y lectura sin conexión",
  "description": "Conecta varias bibliotecas OPDS, explora y lee bajo demanda y entiende las descargas EPUB y la sincronización condicional del progreso.",
  "category": "Bibliotecas y lectura",
  "minutes": 5,
  "published": "2026-10-04",
  "updated": "2026-10-04",
  "related": [
    "local-comics",
    "manga-translation",
    "translation-troubleshooting"
  ],
  "sections": [
    {
      "title": "Conectar una biblioteca autorizada",
      "paragraphs": [
        "Añade la dirección y los datos de acceso de cada biblioteca OPDS en la extensión. Puedes conservar varias conexiones y cambiar entre ellas.",
        "Utiliza una fuente que tengas derecho a consultar. Los permisos del navegador, la autenticación y las funciones del servidor pueden limitar el acceso; OPDS no elude inicios de sesión ni DRM."
      ]
    },
    {
      "title": "Explorar y leer bajo demanda",
      "paragraphs": [
        "Explora el catálogo y usa la búsqueda si la fuente la ofrece. Abre los títulos que te interesen sin importar toda la biblioteca.",
        "La lectura mediante rangos HTTP necesita un recurso y respuestas fiables del servidor. Si no se cumplen esas condiciones, elige expresamente descargar el archivo completo antes de leer; un catálogo OPDS no garantiza lectura progresiva."
      ]
    },
    {
      "title": "EPUB: texto del libro e imágenes integradas",
      "paragraphs": [
        "Los EPUB sin DRM conservan su navegación y texto. Las imágenes de mapa de bits integradas compatibles pueden traducirse manteniendo disponible el original.",
        "No se traduce el texto del documento, los elementos vectoriales ni el contenido protegido por DRM. Los formatos y las posibilidades de lectura dependen de los recursos que ofrece la biblioteca."
      ]
    },
    {
      "title": "Progreso y disponibilidad sin conexión",
      "paragraphs": [
        "El progreso solo se sincroniza cuando la fuente lo admite y se ha verificado su compatibilidad. Un fallo conserva el progreso local; no es una sincronización de toda la biblioteca.",
        "Los recursos descargados por completo y los capítulos totalmente guardados se leen sin conexión mientras sigan en el navegador. Explorar una biblioteca remota y generar nuevas traducciones puede requerir conexión."
      ]
    }
  ]
},
...localTranslationGuides
],
    "policies": {
      "privacy": {
        "title": "Política de privacidad",
        "description": "Cómo NodeLane Comics maneja cuentas, imágenes, permisos, traducción, suscripciones y eliminación.",
        "sections": [
          {
            "title": "Traducción de imágenes de sitios web y pruebas de invitados",
            "paragraphs": [
              "El sitio web acepta imágenes JPG, PNG y WebP. Los archivos originales, las entradas de traducción, los resultados completos y el historial se almacenan en el IndexedDB de este navegador y no se sincronizan entre dispositivos. Al borrar los datos del sitio, se eliminan. \"Eliminar registro local\" elimina solo la copia local, no las tareas del servidor ni los registros de auditoría.",
              "Las pruebas de invitados utilizan Cloudflare Turnstile. Cloudflare procesa las señales de red y del navegador necesarias para la verificación según su política de privacidad; Nuestras solicitudes de verificación no incluyen imágenes de cómics. Utilizamos una cookie de sesión HttpOnly segura que dura hasta 30 días, identificadores de red HMAC y contadores diarios retenidos durante siete días para evitar abusos. Estos identificadores son seudónimos y no garantizan un anonimato total.",
              "Los resultados de invitados se pueden recuperar del servidor durante 24 horas después de que termine una tarea. Después se revoca el acceso y se eliminan los archivos. Los resultados guardados localmente siguen disponibles. Las imágenes de entrada se eliminan al terminar la tarea; los registros necesarios de tareas, costes y seguridad siguen sus propias reglas de conservación. La conservación a largo plazo descrita más abajo se aplica a las cuentas registradas. Los invitados no crean una cuenta del proveedor de identidad; iniciar sesión no fusiona los historiales. La prueba predeterminada admite hasta cinco imágenes nuevas al día, con límites compartidos por red; los fallos también cuentan."
            ]
          },
          {
            "title": "Alcance y contacto",
            "paragraphs": [
              "Esta política cubre el sitio web NodeLane Comics, la extensión, el lector y los servicios de traducción, mantenidos por el equipo NodeLane Comics. Comuníquese con comics@nodelane.net sobre privacidad, acceso, corrección o eliminación. Actualizado el 4 de octubre de 2026. Los cambios materiales se explicarán en esta página y se comunicarán de manera adecuada."
            ]
          },
          {
            "title": "Información y finalidades",
            "paragraphs": [
              "El inicio de sesión OIDC proporciona un identificador de identidad, un nombre para mostrar y una función para cuentas, beneficios y tareas. El producto API valida tokens de acceso. El sitio web no recopila la contraseña que usted ingresa en el proveedor de identidad.",
              "La traducción procesa imágenes de páginas seleccionadas, hashes de contenido, identificadores de archivos/páginas, modo, idioma de destino, estado, resultados y registros de uso. Estos admiten la entrega, comparación, recuperación y reutilización de resultados válidos. Stripe o Creem se encargan del pago y de los detalles completos de la tarjeta de pago; Conservamos los registros de clientes, transacciones y suscripciones necesarios para obtener beneficios, conciliación y soporte.",
              "Los comentarios, el correo electrónico y los archivos adjuntos necesarios ayudan a investigar los problemas. Las operaciones implican solicitudes necesarias de metadatos, seguridad y registros de errores. Los registros predeterminados excluyen credenciales, imágenes privadas, texto de imagen completo y URL de descarga firmadas."
            ]
          },
          {
            "title": "Análisis de uso de extensiones opcionales",
            "paragraphs": [
              "El análisis de uso está desactivado de forma predeterminada. Si opta por participar a través de la configuración de la extensión, se envía información limitada sobre el uso de funciones, categorías de éxito y fracaso, tiempo de lectura activo, interfaz e idiomas de destino, tipos de fuente y versión de la extensión a través del backend de NodeLane a Google Analytics 4 para mejorar el producto. Un identificador aleatorio almacenado en su dispositivo distingue el uso. No está vinculado a su cuenta iniciada ni se utiliza para la orientación de anuncios. Este es un identificador seudónimo, no una promesa de completo anonimato.",
              "Analytics excluye títulos de cómics, imágenes y texto, términos de búsqueda, nombres de archivos, URL de lectura específicas, cookies, credenciales y direcciones de servicios de traducción personalizados. Puede desactivarlo en cualquier momento para detener la recopilación adicional y borrar los registros de análisis locales pendientes y el identificador, sin afectar la lectura o la traducción. Desactivarlo no borra automáticamente los datos ya enviados a Google; Contáctenos para solicitudes que podamos identificar y procesar. Google puede procesar datos analíticos fuera de su región, sujeto a su política de privacidad y nuestra configuración de retención. La retención de datos a nivel de evento y a nivel de usuario de GA4 se establece en 14 meses, sin restablecer la retención de datos del usuario en nuevas actividades; Los informes agregados no están limitados por este período. El sitio web en sí no recopila análisis de uso de GA4."
            ]
          },
          {
            "title": "Permisos y almacenamiento local.",
            "paragraphs": [
              "La extensión declara durante la instalación el acceso a todos los sitios y dominios de imágenes HTTP/HTTPS, sin solicitar permisos por sitio o dominio durante el uso. Puedes limitar el acceso en los ajustes de extensiones del navegador; si alguna función deja de funcionar, restablece el acceso a todos los sitios y vuelve a intentarlo. Las cookies y los tokens de inicio de sesión del sitio de origen y el historial de navegación no se envían al servicio oficial de traducción. Solo se procesan las imágenes seleccionadas y los datos necesarios para la tarea.",
              "La biblioteca, la posición de lectura, las preferencias y los datos locales importados se encuentran en el navegador; el análisis es local y se envían imágenes relevantes cuando se solicita la traducción. La biblioteca no se sincroniza automáticamente. El sitio web mantiene el estado de la cuenta y la autorización, así como los tokens de acceso y actualización en el almacenamiento de la sesión de la pestaña actual. La extensión tiene sus propias reglas de almacenamiento de sesiones. Borrar los datos del navegador puede cerrar sesión o eliminar información de lectura local. El progreso OPDS solo se sincroniza cuando la fuente lo admite y se ha verificado su compatibilidad. Si falla, se conserva el progreso local. No se sincronizan toda la biblioteca ni los archivos de origen. Después de conectar, la contraseña y el token de MTU se guardan localmente en este equipo. Con la misma dirección del servicio y el mismo usuario, deja la contraseña vacía para reutilizar la guardada. Introdúcela otra vez si cambia la dirección, el usuario o la contraseña, si deja de ser válida o si un perfil antiguo solo contiene un token. Guardar la contraseña y reconectar con el campo vacío requiere la extensión 0.10.2 o posterior; en versiones anteriores debes introducirla en cada reconexión."
            ]
          },
          {
            "title": "Proveedores de servicios y transferencias",
            "paragraphs": [
              "La extensión actual solo ofrece traducción clásica. El procesamiento clásico puede implicar detección/OCR, modelos de texto, reparación de fondo local y composición tipográfica. Los proveedores de texto procesan el texto reconocido necesario para la traducción. Los proveedores reales se configuran en el servidor para la tarea.",
              "Las imágenes traducidas utilizan archivos privados en el servidor central; El texto reconocido, las traducciones y los metadatos necesarios se almacenan en la base de datos. Los servicios de identidad, infraestructura, traducción y pago procesan datos según sea necesario, según sus políticas aplicables. El procesamiento puede ocurrir fuera de su región. No vendemos información personal ni utilizamos cómics enviados para orientar anuncios. No prometemos que todos los proveedores no retengan nada o nunca utilicen datos para capacitación; esto depende del proveedor y del acuerdo. No envíe contenido sensible no autorizado o inadecuado."
            ]
          },
          {
            "title": "Retención y eliminación",
            "paragraphs": [
              "Los originales son archivos temporales en el servidor central y en los nodos de computación, que se eliminan después de que una tarea se completa, falla o se cancela. La traducción clásica mantiene archivos superpuestos. Los resultados permanecen privados mientras su cuenta tenga una solicitud válida. El texto reconocido, las traducciones y los metadatos necesarios se almacenan en la base de datos.",
              "Los resultados se reutilizan solo dentro de la misma cuenta cuando el contenido, el modo, el idioma y la configuración efectiva coinciden y permanece una solicitud válida. Los originales y los resultados no se comparten entre los usuarios. El navegador combina superposiciones con su propia imagen original; el servidor no guarda copias originales permanentes. La eliminación de un registro de traducción revoca inmediatamente el acceso al servidor de esa solicitud. Otras solicitudes válidas en su cuenta siguen siendo utilizables; el archivo de resultados se elimina después de revocar la última solicitud válida. Las copias descargadas o almacenadas en caché pueden permanecer en su dispositivo hasta que las borre.",
              "Para solicitudes de eliminación de cuentas o más amplias, contáctenos para verificar la identidad y el alcance. Es posible que sea necesario conservar los registros de transacciones, auditorías o seguridad por obligaciones de servicio, disputas o requisitos aplicables. No se promete una fecha límite única de borrado para todos los registros; la respuesta explicará el resultado y las limitaciones."
            ]
          },
          {
            "title": "Seguridad, opciones y menores",
            "paragraphs": [
              "El servidor central verifica la autorización de la cuenta y devuelve los archivos de resultados directamente, sin emitir enlaces de descarga firmados de corta duración. Las claves del proveedor permanecen en el backend. Proteja su cuenta y dispositivo, y no comparta tokens de acceso. Puede restringir el acceso a sitios en el navegador, detener la traducción, cerrar sesión o eliminar datos del navegador local; En ese caso, es posible que la funcionalidad necesaria no esté disponible. El sitio web no tiene rastreadores de publicidad ni scripts de análisis de terceros.",
              "Los menores deben utilizar el servicio con el conocimiento y la orientación adecuados de un tutor y obtener la autorización necesaria para las suscripciones. No envíe información personal confidencial de niños. Los tutores pueden comunicarse con nosotros para solicitar verificación y manejo de procesamiento inapropiado. Informar problemas de seguridad utilizando únicamente la información necesaria y redactada; No se necesitan contraseñas ni tokens."
            ]
          }
        ]
      },
      "terms": {
        "title": "Términos de servicio",
        "description": "Condiciones de uso de NodeLane Comics, derechos de contenido, limitaciones de IA y suscripciones.",
        "sections": [
          {
            "title": "Servicio y cuentas",
            "paragraphs": [
              "NodeLane Comics proporciona servicios de extensión, lectura y traducción. Lea estos términos y la política de privacidad antes de usar; deje de utilizar el servicio si no está de acuerdo. Actualizado el 4 de octubre de 2026. El sitio web proporciona información de productos, guías, descargas y administración de cuentas, no un catálogo de cómics ni ventas de cómics.",
              "Utilice una cuenta a la que tenga derecho y proteja sus credenciales y su dispositivo. Los beneficios y el acceso se verifican en el servidor. No se haga pasar por otros, no acceda a sus registros privados, no supere los límites de velocidad o de imagen, no interrumpa los servicios con automatización abusiva ni ataque el producto y sus proveedores. El mal uso puede dar lugar a un acceso restringido."
            ]
          },
          {
            "title": "Derechos de contenido y resultados de IA",
            "paragraphs": [
              "Debe tener derecho a acceder, cargar, traducir y procesar contenido seleccionado y seguir los requisitos del sitio de origen y del titular de los derechos. La extensión no otorga derechos de autor ni permiso automático para publicar imágenes traducidas. No omita los muros de pago, los requisitos de inicio de sesión o DRM. No garantizamos la legalidad o integridad del contenido fuente. Las consultas sobre derechos de autor deben identificar la obra, los derechos, el problema y la información de contacto.",
              "La IA puede omitir, traducir mal o colocar mal el texto. Los resultados ayudan a leer y no sustituyen los originales ni una revisión profesional. Las ilustraciones originales del sitio se generan con IA; las comparaciones de idiomas son ejemplos registrados de traducción clásica. No garantizan precisión ni velocidad para cada imagen. Puedes comparar los originales y enviar comentarios."
            ]
          },
          {
            "title": "Beneficios y suscripciones",
            "paragraphs": [
              membershipSummary,
              "Las suscripciones ofrecen facturación mensual o anual. Los precios, las pruebas y las asignaciones de páginas siguen la oferta seleccionada, que se renueva automáticamente en ese intervalo. Los cambios de precios se aplican a las nuevas suscripciones; Las suscripciones existentes mantienen su precio original y su versión de beneficios. Cancelar antes de la renovación."
            ]
          },
          {
            "title": "Cambios y contacto",
            "paragraphs": [
              "Los cambios en el sitio de origen y la disponibilidad de terceros pueden afectar la recuperación, la traducción o el inicio de sesión de las imágenes. Mantenemos el producto, pero no garantizamos acceso o soporte ininterrumpido para cada sitio, archivo e idioma. Los cambios en las características del material, el precio y los términos se explicarán en las páginas correspondientes.",
              "Estos términos no excluyen derechos o responsabilidades obligatorios del consumidor que la ley aplicable no permite excluir. Comuníquese con comics@nodelane.net sobre problemas o disputas con los detalles redactados necesarios para que podamos investigar."
            ]
          }
        ]
      },
      "refund": {
        "title": "Suscripciones, bajas y devoluciones",
        "description": "Las suscripciones ofrecen facturación mensual o anual. Los precios, las pruebas y las asignaciones de páginas siguen la oferta seleccionada, que se renueva automáticamente en ese intervalo. Los cambios de precios se aplican a las nuevas suscripciones; Las suscripciones existentes mantienen su precio original y su versión de beneficios. Cancelar antes de la renovación.",
        "sections": [
          {
            "title": "Prueba y facturación",
            "paragraphs": [
              "Las suscripciones ofrecen facturación mensual o anual. Los precios, las pruebas y las asignaciones de páginas siguen la oferta seleccionada, que se renueva automáticamente en ese intervalo. Los cambios de precios se aplican a las nuevas suscripciones; Las suscripciones existentes mantienen su precio original y su versión de beneficios. Cancelar antes de la renovación.",
              "Las cuentas elegibles pueden iniciar la prueba indicada para su plan, que requiere una tarjeta. Volver a suscribirse o elegir otro plan no restablece el derecho a la prueba."
            ]
          },
          {
            "title": "Detener futuras renovaciones",
            "paragraphs": [
              "Inicie sesión en su cuenta del sitio web o utilice la entrada de la cuenta de extensión para administrar la suscripción. La cancelación detiene la próxima renovación y no borra automáticamente los beneficios ya válidos; confíe en el vencimiento que se muestra en su cuenta.",
              "Cancele antes de que finalice la prueba si no desea la renovación paga. Desinstalar, cerrar el navegador o cerrar sesión no cancela una suscripción. Envíe un correo electrónico a comics@nodelane.net si no puede acceder a su cuenta."
            ]
          },
          {
            "title": "Asignación de páginas versus pago",
            "paragraphs": [
              "Una reserva de tarea es independiente de una transacción de pago. Un fallo explícito libera páginas reservadas según las reglas; primero se verifica un resultado desconocido. Este no es un reembolso automático de las tarifas de suscripción. Los resultados válidos existentes siguen siendo accesibles después de que expire la membresía, mientras que las nuevas tareas utilizan el derecho al momento de la aceptación."
            ]
          },
          {
            "title": "Solicitar ayuda con la facturación o un reembolso",
            "paragraphs": [
              "Para cargos duplicados, transacciones anormales o servicio inutilizable, envíe un correo electrónico con su identificador de cuenta, ID de pedido/transacción, fecha y una descripción. Nunca envíe un número de tarjeta completo, contraseña o token.",
              "Revisamos el pedido, las circunstancias del servicio, las reglas del canal de pago y los derechos aplicables del consumidor y luego explicamos el resultado. La aprobación no es automática y esta política no excluye los derechos obligatorios de reembolso o retiro. Los reembolsos aprobados llegan según el tiempo de procesamiento del proveedor de pagos y del emisor de la tarjeta."
            ]
          }
        ]
      }
    },
    "faqs": [
      {
        "id": "overview",
        "question": "¿Qué es NodeLane Comics?",
        "answer": "NodeLane Comics ofrece una extensión para descubrir, leer y traducir manga de archivos locales, EPUB, Google Drive, bibliotecas OPDS y sitios compatibles. También traduce imágenes de páginas y áreas visibles. La web ofrece un espacio independiente para JPG, PNG y WebP, con prueba para invitados, cuota de cuenta e historial local. No ofrecemos un catálogo de manga.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "browsers",
        "question": "¿El traductor de manga funciona en Chrome, Edge y Firefox?",
        "answer": "Sí, en Chrome, Microsoft Edge y Firefox de escritorio. Usa los enlaces a las tiendas oficiales en la página de descarga o consigue el paquete correspondiente a tu navegador.",
        "relatedPath": "/download/"
      },
      {
        "id": "installation",
        "question": "¿Cómo instalo la extensión del traductor de manga o el paquete ZIP?",
        "answer": "Utilice los enlaces oficiales de la tienda Chrome, Edge o Firefox en la página de descarga. Para la instalación manual de Chrome o Edge, descargue y extraiga el ZIP correspondiente, habilite el modo Desarrollador en el administrador de extensiones y seleccione Cargar descomprimido. Firefox usa su ficha de Play Store o el XPI firmado. Consulte la página de descarga para obtener instrucciones.",
        "relatedPath": "/download/"
      },
      {
        "id": "free-plan",
        "question": "¿La traducción de manga es gratuita y qué incluye PLUS / Pro?",
        "answer": membershipSummary,
        "relatedPath": "/pricing/"
      },
      {
        "id": "translation-modes",
        "question": "¿Qué traducción ofrece la extensión y qué servicio puedo elegir?",
        "answer": "La extensión actual solo ofrece traducción clásica, con comparación y vuelta al original. Usa el servicio oficial con tu cuenta o conecta tu propio manga-translator-ui sin cuota oficial.",
        "relatedPath": "/guides/translation-modes/"
      },
      {
        "id": "file-formats",
        "question": "¿Qué archivos puedo importar?",
        "answer": "Importa archivos compatibles CBZ/ZIP, CBR/RAR, PDF y MOBI o EPUB sin DRM. EPUB conserva la lectura del documento; solo se traducen sus imágenes de mapa de bits integradas, no el texto del libro ni los elementos vectoriales. No se importan imágenes sueltas, archivos KF8/AZW3 independientes ni libros cifrados. Los sitios necesitan un adaptador dedicado.",
        "relatedPath": "/guides/local-comics/"
      },
      {
        "id": "website-permissions",
        "question": "¿La extensión carga cookies del sitio web o historial de navegación?",
        "answer": "La extensión declara durante la instalación el acceso a todos los sitios y dominios de imágenes HTTP/HTTPS, sin solicitar permisos por sitio o dominio durante el uso. Puedes limitar el acceso en los ajustes de extensiones del navegador; si alguna función deja de funcionar, restablece el acceso a todos los sitios y vuelve a intentarlo. Las cookies y los tokens de inicio de sesión del sitio de origen y el historial de navegación no se envían al servicio oficial de traducción. Solo se procesan las imágenes seleccionadas y los datos necesarios para la tarea.",
        "relatedPath": "/guides/comic-reader-privacy/"
      },
      {
        "id": "image-privacy",
        "question": "¿Se cargan o retienen las imágenes?",
        "answer": "Cuando usas la traducción oficial, se aplican las siguientes reglas de conservación. La traducción envía imágenes de páginas seleccionadas al backend y a los proveedores relevantes. Los originales son archivos temporales en el servidor central y en los nodos de computación, que se eliminan después de que una tarea se completa, falla o se cancela. La traducción clásica mantiene archivos superpuestos. Los resultados permanecen privados mientras su cuenta tenga una solicitud válida. El texto reconocido, las traducciones y los metadatos necesarios se almacenan en la base de datos. La eliminación de un registro de traducción revoca inmediatamente el acceso al servidor de esa solicitud. Otras solicitudes válidas en su cuenta siguen siendo utilizables; el archivo de resultados se elimina después de revocar la última solicitud válida. Las copias descargadas o almacenadas en caché pueden permanecer en su dispositivo hasta que las borre. Las cookies de origen, los tokens de inicio de sesión y el historial de navegación no se cargan. La extensión actual solo ofrece traducción clásica. Con MTU, las imágenes se envían directamente al servicio seleccionado; el procesamiento y la conservación dependen de su configuración.",
        "relatedPath": "/privacy/"
      },
      {
        "id": "translation-failed",
        "question": "¿Las traducciones fallidas utilizan páginas?",
        "answer": "En las tareas oficiales de tu cuenta, las páginas pueden reservarse antes del procesamiento y descontarse tras una entrega correcta. Un fallo explícito libera la reserva, igual que un resultado clásico confirmado sin texto o con reconocimiento parcial y el original conservado. MTU no consume la cuota oficial de NodeLane. La prueba para invitados sigue por separado las reglas de solicitudes aceptadas que muestra el espacio web, donde los fallos también pueden contar.",
        "relatedPath": "/guides/translation-troubleshooting/"
      },
      {
        "id": "plus-limits",
        "question": "¿Cómo funcionan los límites de traducción de PLUS / Pro?",
        "answer": "Una cuenta comparte un límite de 100 imágenes nuevas para traducir en cada período móvil de 60 segundos y 1200 en cada período móvil de 3600 segundos, entre todos sus dispositivos, modos e idiomas. El plan Gratis permite 10 en cada período móvil de 60 segundos. Repetir la misma solicitud o reutilizar resultados válidos no vuelve a contar. Las tareas aceptadas cuentan aunque fallen, se cancelen o no contengan texto. Las solicitudes rechazadas y las transacciones revertidas de la base de datos liberan el espacio reservado en el cupo horario. Los reintentos siguen las reglas reales de admisión de nuevas tareas. Estos límites no garantizan una velocidad de finalización.",
        "relatedPath": "/pricing/"
      },
      {
        "id": "cancel-subscription",
        "question": "¿Cómo cancelo?",
        "answer": "Utilice el sitio web o la entrada de la cuenta de extensión para administrar la suscripción. Cancelar antes de la próxima renovación o vencimiento de la prueba; la desinstalación no cancela. Los beneficios existentes siguen el vencimiento que se muestra en su cuenta. Para obtener ayuda con la facturación, envíe un correo electrónico a comics@nodelane.net.",
        "relatedPath": "/refund/"
      },
      {
        "id": "supported-sites",
        "question": "¿Funciona en todos los sitios e idiomas?",
        "answer": "Importar manga desde un sitio requiere un adaptador dedicado. La traducción en la página, con clic derecho o mediante un área visible puede funcionar en otras páginas, según el acceso a las imágenes y los permisos del navegador. Los idiomas disponibles dependen del servicio seleccionado. No se garantizan todos los sitios, archivos e idiomas.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "local-translation",
        "question": "¿Puedo traducir manga con un servicio local sin una cuenta NodeLane?",
        "answer": "Añade tu servicio manga-translator-ui en los ajustes y selecciónalo para la traducción clásica. Puedes guardar varios perfiles; solo se utiliza uno a la vez. No necesitas cuenta NodeLane ni cuota oficial. La contraseña y el token de MTU se guardan en este equipo. El procesamiento, los costes de modelos y los requisitos de red dependen de tu servicio; un MTU local no garantiza una traducción totalmente sin conexión. Guardar la contraseña y reconectar con el campo vacío requiere la extensión 0.10.2 o posterior; en versiones anteriores debes introducirla en cada reconexión.",
        "relatedPath": "/guides/local-translation/"
      },
      {
        "id": "remote-library",
        "question": "¿Puedo conectar varias bibliotecas OPDS?",
        "answer": "Sí. Añade varias direcciones y sus datos de acceso para explorar, buscar y leer bajo demanda. La búsqueda y los formatos dependen de la fuente. La lectura fiable mediante rangos HTTP evita descargar todo el archivo; si no es posible, debe elegirse expresamente la descarga completa. El progreso solo se sincroniza con fuentes compatibles y verificadas; si falla, se conserva el progreso local.",
        "relatedPath": "/guides/remote-library/"
      },
      {
        "id": "region-translation",
        "question": "¿Cómo traduzco una imagen o un área de la página?",
        "answer": "Usa la traducción de la página, el clic derecho sobre una imagen o la selección de un rectángulo visible. La selección no desplaza la página para unir una captura larga. Puedes configurar los atajos en los ajustes nativos del navegador. Una página sin adaptador no puede importarse como manga.",
        "relatedPath": "/guides/manga-translation/"
      },
      {
        "id": "offline-reading",
        "question": "¿Qué puedo leer sin conexión?",
        "answer": "Los archivos locales importados, los recursos remotos descargados por completo y los capítulos totalmente guardados pueden leerse mientras sigan disponibles en el navegador. Puedes guardar los mangas de sitios en los idiomas de origen seleccionados, pausar, continuar y completar páginas pendientes. Cerrar la página de la tarea pausa la planificación. Las nuevas traducciones oficiales requieren conexión; un MTU local también necesita un flujo completamente sin conexión.",
        "relatedPath": "/guides/remote-library/"
      }
    ],
    "releases": [
      {
        "id": "0.10.0",
        "date": "2026-10-04",
        "title": "0.10.0: Más fuentes, más formas de leer.",
        "items": [
          "Bibliotecas OPDS y sincronización del progreso de lectura",
          "Reconocimiento OCR de texto más preciso",
          "Traducción anticipada mejorada, menos esperas al pasar de página",
          "Lectura EPUB y traducción de imágenes",
          "Traduce una zona seleccionada en la web",
          "Atajos personalizados para leer y traducir",
          "Soporte completo para 6 nuevos sitios de cómics: MangaPill, MangaDNA, KLManga, RawLazy, Comic DAYS, Manga One.",
          "Los paquetes Chrome y Edge 0.10.0 ZIP y el Firefox 0.10.0 XPI firmado por AMO están disponibles."
        ]
      },
      {
        "id": "0.9.1",
        "date": "2026-10-02",
        "title": "0.9.1: Más fuentes y mejor soporte para cómics largos",
        "items": [
          "Se agregaron fuentes de Atsumaru, MangaBall, RawOtaku y JF00, con importación directa de manga para lectura.",
          "Traduzca títulos y descripciones en la página Descubrir, cambie entre texto original y traducido, verifique el estado de la traducción y vuelva a intentar fallas.",
          "Traducción clásica mejorada para historietas muy largas, incluido el guardado de imágenes traducidas completas y la recuperación de tareas interrumpidas.",
          "Se corrigió el truncamiento de dimensiones al codificar imágenes extremadamente largas como JPEG. Las imágenes traducidas completas utilizan PNG cuando sea necesario.",
          "Se corrigieron fallas en el envío de traducciones oficiales con algunas imágenes AVIF mientras se mantenía la lectura de los originales sin cambios.",
          "Recuerda el zoom para cada libro y carga previamente las páginas adyacentes de alta resolución, con mejoras en la carga continua de capítulos, el desplazamiento y la retención de la posición de lectura.",
          "Se agregaron notas de la versión en la aplicación y avisos descartables para sesiones de inicio de sesión caducadas y errores de imagen.",
          "Los paquetes Chrome y Edge 0.9.1 ZIP y el Firefox 0.9.1 XPI firmado por AMO están disponibles."
        ]
      },
      {
        "id": "0.8.0",
        "date": "2026-09-30",
        "title": "0.8.0: guarde traducciones completas para una lectura más fluida",
        "items": [
          "Las imágenes traducidas completas se guardan localmente en su navegador y se reutilizan al volver a leer, cambiar entre originales y traducciones o exportar, lo que reduce la composición repetida de las imágenes.",
          "Se corrigió la retención de la posición de lectura a través de los límites de los capítulos para que pueda continuar desde la posición correcta después de cambiar de capítulo.",
          "My Comics se abre automáticamente después de la primera instalación y te lleva directamente a tu biblioteca.",
          "Las conexiones de eventos de traducción se reutilizan y la información del cliente se almacena en caché, lo que reduce las conexiones y solicitudes repetidas.",
          "Se agregaron comentarios de desinstalación multilingües opcionales para informar problemas y compartir sugerencias.",
          "Los paquetes Chrome y Edge 0.8.0 ZIP y el Firefox 0.8.0 XPI firmado por AMO están disponibles."
        ]
      },
      {
        "id": "0.7.0",
        "date": "2026-09-29",
        "title": "0.7.0: Importar artistas y series de Pixiv",
        "items": [
          "Importe páginas de inicio de artistas de Pixiv con ilustraciones y manga, elija cualquier categoría o importe solo obras bajo una etiqueta específica.",
          "Importe enlaces de la serie Pixiv directamente. Cada colección se convierte en un libro y cada obra de arte en un capítulo, con cada imagen original disponible en obras de varias páginas.",
          "Los libros Pixiv importados admiten comprobaciones de actualizaciones periódicas e insignias de actualización de la biblioteca. Importar la misma colección nuevamente mantiene el libro existente y el progreso de lectura.",
          "Se agregó un botón de importar/administrar a las páginas de artistas, categorías, etiquetas y series de Pixiv. Las entradas de Pixiv omiten la acción de búsqueda de idioma alternativo.",
          "Las páginas de ilustraciones de Pixiv utilizan la experiencia de traducción de imágenes de páginas web existente, con cambio entre imágenes originales y traducidas.",
          "Los paquetes Chrome y Edge 0.7.0 están disponibles. Firefox permanece en la versión 0.6.0 firmada y aún no incluye estas nuevas características."
        ]
      },
      {
        "id": "0.6.0",
        "date": "2026-09-27",
        "title": "0.6.0: Descubra manga y almacene libros completos en caché para leerlos sin conexión",
        "items": [
          "Descubra manga con AniList lanzamientos nuevos, populares, mejor valorados y de tendencia. Filtre por género y más, luego busque la fuente de un sitio web a partir de los detalles e impórtelo para leerlo.",
          "Almacene en caché el manga completo del sitio web para leerlo sin conexión, incluidos catálogos y capítulos completos. Seleccione varios idiomas de origen, realice un seguimiento del progreso, haga una pausa y reanude, y vuelva a intentar las páginas fallidas.",
          "Se agregó soporte para MangaDot, Sunday Webry, WEBTOON internacional y Baozimh, con mejoras en la búsqueda de sitios web, portadas y carga de imágenes.",
          "Se agregó progreso de lectura, recuentos de actualizaciones y filtros a la biblioteca; reutilización de portada mejorada y restauración de desplazamiento al cambiar de página.",
          "Reutilización de caché del lector mejorada, recuperación de URL de imágenes caducadas y clasificación de capítulos, con íconos de estilo cómic, insignias de cuenta y resultados de importación consistentes.",
          "Los paquetes de descarga Chrome, Edge y Firefox 0.6.0 están disponibles. Firefox utiliza el XPI firmado por AMO."
        ]
      },
      {
        "id": "0.5.0",
        "date": "2026-09-26",
        "title": "0.5.0: Encuentra manga en todos los idiomas y sitios",
        "items": [
          "Nueva página de búsqueda de manga dedicada, con búsqueda también disponible desde la biblioteca, el lector y la página web. Inicia sesión para buscar nombres de manga existentes en otros idiomas o ingresa una palabra clave manualmente.",
          "Busque en varios sitios en paralelo, y los resultados aparecerán progresivamente y entrelazados por fuente. Verifique el estado de cada sitio, reintente fallas, cargue más resultados e importe un título para leer.",
          "Se recuerdan las opciones de idioma de búsqueda y sitio. Cambiar las selecciones de sitios mantiene los resultados actuales. Las pantallas de búsqueda ahora comparten un diseño consistente y muestran etiquetas de idioma del sitio.",
          "Se corrigió la codificación de búsqueda DM5 para palabras clave que contienen espacios. Al cambiar de canal de traducción ahora solo se actualizan los capítulos cargados, lo que reduce las actualizaciones innecesarias del lector.",
          "Las descargas Chrome, Edge y Firefox 0.5.0 están disponibles. Firefox utiliza el XPI firmado por AMO; Las versiones de la tienda dependen de la finalización de la revisión."
        ]
      },
      {
        "id": "0.4.0",
        "date": "2026-09-25",
        "title": "0.4.0: Más fuentes de manga, lectura más fluida",
        "items": [
          "Se agregaron fuentes MangaDex y Guazi Manga con un flujo unificado de importación de enlaces a sitios web. Se mejoró la carga y recuperación del catálogo MangaCopy de fallas de importación de DM5.",
          "Elija un idioma de lectura para cada capítulo de MangaDex, con indicadores de idioma en el directorio para que sea más fácil encontrar capítulos y cambiar entre ellos.",
          "Se perfeccionó el directorio de lectores y las acciones comunes, se agregaron más colores de acento y se mejoraron la interfaz y los selectores de idioma de traducción.",
          "Se corrigió la compatibilidad de Firefox con las reglas de encabezado de solicitud de imagen para una carga de imágenes más confiable desde sitios compatibles.",
          "Las descargas de Chrome y Edge 0.4.0 están disponibles. La descarga de Firefox sigue siendo la 0.3.0 firmada por AMO; Las versiones de la tienda dependen de la finalización de la revisión."
        ]
      },
      {
        "date": "2026-09-25",
        "title": "0.3.0: Conecta tu propio servicio de traducción",
        "items": [
          "La nueva configuración del canal de traducción le permite elegir NodeLane o su propio servicio manga-translator-ui. Guarde múltiples configuraciones de servicio y use su propio servicio sin una cuenta NodeLane.",
          "El lector y la traducción en la página comparten su canal seleccionado, traduciendo la imagen actual y las tres siguientes. El cambio de canales conserva la posición de lectura y mantiene separadas las imágenes traducidas.",
          "Las traducciones largas en la página pueden seguir esperando resultados mientras el proceso en segundo plano de la extensión duerme. Las conexiones interrumpidas ofrecen un reintento manual sin volver a enviar la imagen automáticamente.",
          "Exportación y almacenamiento en caché de imágenes traducidas mejorados, con instrucciones claras sobre cuándo borrar el caché significa que un resultado de su propio servicio debe traducirse nuevamente.",
          "Se encuentran disponibles descargas independientes de Chrome y Edge 0.3.0. Elija el paquete para que su navegador actualice."
        ]
      },
      {
        "date": "2026-09-20",
        "title": "Un comienzo más claro para la lectura.",
        "items": [
          "El descubrimiento de imágenes comienza con su clic, preservando la selección y el orden al actualizar la misma página.",
          "La renovación de la cuenta incluye mensajes claros de recuperación para problemas de conectividad y autorización.",
          "El sitio web agrega guías, información de productos y una entrada de cuenta compartida."
        ]
      },
      {
        "date": "2026-09-19",
        "title": "Leyendo primero, una página traducida a la vez",
        "items": [
          "La traducción automática cubre la imagen actual y las dos siguientes conservando la posición de lectura.",
          "La admisión de minutos continuos cuenta las nuevas imágenes traducidas; los duplicados y la reutilización de resultados completados no cuentan dos veces.",
          "Los resultados por página y la verificación de la tarea original admiten la recuperación después de la desconexión."
        ]
      },
      {
        "date": "2026-09-15",
        "title": "Un hogar más claro para historias largas",
        "items": [
          "Navegación de capítulos separada y miniaturas de páginas.",
          "Encuentre traducciones existentes por modo e idioma.",
          "Lectura local de imágenes, archivos de cómic, PDF y MOBI sin DRM compatibles."
        ]
      }
    ]
  },
  "account": {
    "赠送 PLUS {0} 天": "{0} días de superdotado PLUS",
    "赠送安排处理中，请刷新查看。": "Se está programando tu donación. Actualizar para comprobar.",
    "赠送生效：{0}": "El regalo comienza: {0}",
    "赠送结束：{0}": "El regalo finaliza: {0}",
    "已付费权益至 {0}": "Acceso pago hasta {0}",
    "续费延期处理中，请刷新查看。": "Su renovación está siendo aplazada. Actualizar para comprobar.",
    "正在恢复续费，请刷新查看。": "Se reanuda la renovación. Actualizar para comprobar.",
    "正在取消续费，请刷新查看。": "Se cancela la renovación. Actualizar para comprobar.",
    "续费安排需要核实，请刷新或联系支持。": "Su renovación necesita verificación. Actualizar o contactar con soporte.",
    "赠送期间不扣款，结束后恢复自动续费。": "Sin cargos de renovación durante el regalo. La renovación automática se reanuda después.",
    "预计恢复续费：{0}": "Reinicio de renovación esperado: {0}",
    "下次续费：{0}": "Próxima renovación: {0}",
    "已关闭自动续费，已付款及赠送权益保留。": "La renovación automática está desactivada. Se conservan los accesos de pago y para regalos.",
    "赠送结束后可开通订阅。": "Podrás suscribirte cuando finalice tu regalo.",
    "取消自动续费": "Cancelar renovación automática",
    "取消后保留已付款及赠送权益，到期后不再扣款。": "El acceso pago y regalado permanece después de la cancelación. No hay más cargos de renovación.",
    "确认取消续费": "Confirmar cancelación",
    "保留自动续费": "Mantener la renovación automática",
    "账户信息": "Información de la cuenta",
    "退出登录": "Cerrar sesión",
    "会员有效期至": "Membresía válida hasta ",
    "阅读、翻译和用量查看，请前往浏览器插件。": "Para la lectura continua y el detalle del uso de la extensión, abre la extensión. La traducción de imágenes de la web también utiliza la cuota de esta cuenta.",
    "下载插件": "Descargar extensión",
    "会员订阅": "Membresía",
    "刷新": "Actualizar",
    "订阅状态": "Estado de suscripción",
    "下次计费": "Próximo pago",
    "停止续费时间": "Finaliza la renovación",
    "选择订阅套餐": "Elige una suscripción",
    "网络连接失败，请检查连接后重试。": "La conexión falló. Verifique su red e inténtelo nuevamente.",
    "操作暂未完成，请重试或重新登录。": "La acción no se pudo completar. Vuelva a intentarlo o inicie sesión nuevamente.",
    "正在确认登录结果，请稍候…": "Confirmando su inicio de sesión...",
    "返回账户重新登录 ↗": "Volver para iniciar sesión ↗",
    "重试连接": "Reintentar conexión",
    "正在读取你的账户…": "Cargando tu cuenta…",
    "下一页，": "Tu próxima página.",
    "读懂新世界。": "Un mundo que entiendes.",
    "あ → 你好": "あ → Hola",
    "一个账户，连接官网与插件。": "Una identidad para el sitio web y la extensión.",
    "你的翻译权益，都在这里。": "Tus beneficios de traducción, todos aquí.",
    "打开你的读者通行证": "Abre tu pase de lector",
    "前往统一身份服务安全登录，完成后自动回到这里。": "Inicie sesión de forma segura a través de nuestro servicio de identidad y luego regrese aquí automáticamente.",
    "正在前往登录…": "Abriendo inicio de sesión…",
    "登录 / 注册": "Iniciar sesión / Registrarse",
    "继续前请阅读": "Antes de continuar, lee nuestra ",
    "服务条款": "Términos de servicio",
    "与": " y ",
    "隐私政策": "Política de privacidad",
    "。官网不会收集你的登录密码。": ". Este sitio web no recopila su contraseña.",
    "你好，": "Hola, ",
    "退出官网账户": "Cerrar sesión en este sitio web",
    "当前套餐": "plan actual",
    "普通账户": "Gratis",
    "常规翻译": "Traducción clásica",
    "不限累计页数": "Total de páginas ilimitadas",
    "页": " paginas",
    " 页可用": " paginas disponibles",
    "你的阅读权益": "Los beneficios de tu lectura",
    "PLUS 权益到期：": "Los beneficios PLUS caducan: ",
    "（北京时间）": " (Asia/Shanghai)",
    "每滚动 60 秒最多新增": "Nuevas imágenes cada 60 segundos consecutivos: ",
    "张翻译图片，跨模式、语言和设备合计。额度以服务端当前状态为准。": " en todos los modos, idiomas y dispositivos. Se aplican los derechos de servidor actuales.",
    "打开下一段故事 ↗": "Abre tu próxima historia ↗",
    "刷新权益": "Actualizar beneficios",
    "PLUS 订阅": "PLUS suscripción",
    "暂时无法读取订阅状态，请刷新重试。": "El estado de la suscripción no está disponible. Actualiza para intentarlo de nuevo.",
    "订阅服务当前不可用。已有权益不受此提示影响，如需帮助请联系 comics@nodelane.net。": "Las suscripciones no están disponibles actualmente. Este aviso no cambia los beneficios existentes. Comuníquese con comics@nodelane.net para obtener ayuda.",
    "当前状态：": "Estado: ",
    "订阅生效中": "Activo",
    "试用中": "juicio",
    "账单待处理": "Pago pendiente",
    "下次计费：": "Próxima facturación: ",
    "已安排取消续费：": "Cancelación de renovación programada: ",
    "确认停止下一次自动续费？现有权益保留至账户显示的到期时间。": "¿Detener la próxima renovación automática? Los beneficios existentes permanecen hasta el vencimiento que se muestra en su cuenta.",
    "保持订阅": "Mantener suscripción",
    "在 Stripe 管理订阅": "Administrar suscripción en Stripe",
    "可在下次续费前取消，税费及应付金额以结账页为准。": "Cancelar antes de la próxima renovación. Los impuestos y el total final se muestran al finalizar la compra.",
    "我已阅读": "he leído ",
    "订阅与退款说明": "Suscripciones y reembolsos",
    "，了解自动续费规则。": " y comprender la renovación automática.",
    "继续原结账": "Reanudar pago",
    "前往安全结账": "Continuar para asegurar el pago",
    "退出仅清除官网当前标签页的账户会话，不会取消订阅，也不会退出插件或身份服务中的其他应用。": "Al cerrar sesión, se elimina la sesión del sitio en todas las pestañas de este navegador. No se cancelan suscripciones ni se cierra sesión en la extensión u otras aplicaciones.",
    "正式登录服务尚未配置，请稍后重试或联系支持。": "El inicio de sesión no está configurado. Vuelva a intentarlo más tarde o comuníquese con el soporte.",
    "暂时无法连接登录服务，请重试。": "No se puede acceder al servicio de inicio de sesión. Por favor inténtalo de nuevo.",
    "登录续期未完成，请检查网络后重试；授权已失效时请重新登录。": "La renovación de la sesión falló. Verifique su conexión o inicie sesión nuevamente si la autorización expiró.",
    "登录未完成或授权已过期，请返回账户页重新登录。": "El inicio de sesión falló o expiró. Regrese a su cuenta para iniciar sesión nuevamente.",
    "请登录后查看账户。": "Inicie sesión para ver su cuenta.",
    "账户已退出，请重新登录。": "Cerraste la sesión. Por favor inicia sesión nuevamente.",
    "账户服务暂时不可用，请重试。": "Los servicios de cuenta no están disponibles. Vuelva a intentarlo.",
    "一页，两种读法。": "Una página, dos idiomas.",
    "插画语言对照": "Comparación del lenguaje de ilustración",
    "日文原图": "original japonés",
    "一页，多种语言。": "Una página. Muchos idiomas.",
    "英文示意": "ingles",
    "韩文示意": "coreano",
    "正在加载图片…": "Cargando imagen…",
    "图片加载失败": "La imagen no se pudo cargar",
    "重新加载": "Reintentar",
    "中文示意": "ilustración china",
    "原创漫画：海边站台上的旅人，气泡文字为日文": "Manga original: un viajero costero con diálogos japoneses",
    "相同漫画的中文示意：下一站，会是怎样的世界？": "Versión china de la misma ilustración manga original.",
    "产品常规翻译实测效果": "Resultados reales de la traducción estándar del producto."
  }
} satisfies Dictionary;
