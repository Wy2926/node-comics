import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Traducción de manga local: conecte manga-translator-ui a NodeLane",
    "description": "Configure el servicio web manga-translator-ui, conéctelo a NodeLane y traduzca su primera página de cómic. Incluye solución de problemas de conexión, inicio de sesión, espera y caché.",
    "category": "Tutorial de traducción local",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-10-04",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Antes de empezar",
        "paragraphs": [
          "NodeLane Comics maneja la lectura en su navegador; manga-translator-ui (MTU) procesa las imágenes. Su propio canal MTU no necesita una cuenta NodeLane y no utiliza ningún subsidio de traducción oficial. Los costos de hardware, modelos y terceros API siguen siendo suyos.",
          "Necesita la última extensión del navegador de escritorio, un servicio MTU instalado con sus dependencias y el nombre de usuario y la contraseña de ese servicio. Este tutorial utiliza http://127.0.0.1:8000 en la misma computadora que el navegador. Utilice su puerto real si es diferente."
        ],
        "links": [
          {
            "label": "Descargar NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Instalación oficial de MTU: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Instalación oficial de MTU: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Inicie el servicio web MTU",
        "paragraphs": [
          "La extensión necesita un servicio web HTTP. Abrir la ventana del escritorio MTU por sí solo no es suficiente. Después de instalar MTU, ejecute este comando en el directorio de su proyecto y mantenga el servicio en ejecución. Omita este comando si ya ejecuta el servicio web a través de Docker u otro método.",
          "Este ejemplo no habilita el procesamiento de GPU. Agregue --use-gpu solo después de configurar un entorno de GPU compatible como se describe anteriormente. Los requisitos de modelo, controlador y hardware dependen de su versión MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Instrucciones oficiales de lanzamiento web MTU",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Traducir primero una imagen de prueba en MTU",
        "paragraphs": [
          "Abra http://127.0.0.1:8000 en su navegador, complete la configuración de la cuenta de MTU e inicie sesión. Si requiere un cambio de contraseña inicial, complételo en MTU antes de conectar la extensión. Estas son credenciales MTU, independientes de su cuenta NodeLane.",
          "Configure el traductor, los modelos y las claves API requeridas en el servidor, luego confirme que una imagen de prueba produzca una imagen traducida. La extensión establece el idioma de destino y utiliza los valores predeterminados del servidor para otras configuraciones de traducción. Asegúrese de que el servicio web utilice los valores predeterminados previstos. No ingrese una clave de modelo API en el campo de contraseña de la extensión."
        ],
        "links": [
          {
            "label": "Proyecto y documentación oficial MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Agrega un canal de traducción en la extensión.",
        "paragraphs": [
          "Después de conectar, la contraseña y el token de MTU se guardan localmente en este equipo. Con la misma dirección del servicio y el mismo usuario, deja la contraseña vacía para reutilizar la guardada. Introdúcela otra vez si cambia la dirección, el usuario o la contraseña, si deja de ser válida o si un perfil antiguo solo contiene un token. Guardar la contraseña y reconectar con el campo vacío requiere la extensión 0.10.2 o posterior; en versiones anteriores debes introducirla en cada reconexión."
        ],
        "steps": [
          "Elija Agregar canal de traducción y confirme manga-translator-ui como servicio. Opcionalmente, asígnele un nombre reconocible, como \"Mi computadora\".",
          "Ingrese http://127.0.0.1:8000 como dirección de servicio. Utilice la raíz del servicio, sin /auth/login, /translate/with-form/image o una ruta de página de administración.",
          "Introduce tu usuario y contraseña de MTU y elige Conectar y usar. Revisa las restricciones de acceso a esa dirección en los ajustes del navegador.",
          "Verifique que el canal actual muestre el nuevo servicio. Puede guardar varios perfiles de servicio, pero solo se utiliza el canal seleccionado a la vez."
        ]
      },
      {
        "title": "4. Lee tu primera página traducida",
        "paragraphs": [
          "Importa un manga local o abre una fuente compatible en el lector. Elige un idioma y la traducción clásica con tu canal MTU seleccionado.",
          "La página actual tiene prioridad, seguida de una ventana limitada de imágenes cercanas. Las imágenes se procesan de una en una en el mismo canal MTU. Compara original y traducción sin perder tu posición; el lector y la traducción en la página usan el mismo servicio seleccionado.",
          "Si una página falla, resuelva el problema informado antes de volver a intentarlo manualmente. Cerrar una página o perder la conexión no prueba que MTU dejó de calcular. Evite envíos repetidos mientras el servicio aún esté ocupado."
        ],
        "links": [
          {
            "label": "Importación de cómics locales y formatos compatibles.",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Solucionar problemas de conexiones, inicios de sesión y largas esperas",
        "paragraphs": [
          "Verifique MTU antes de volver a intentarlo en la extensión. No comparta contraseñas, tokens o archivos de cómics privados al informar un problema."
        ],
        "table": {
          "headers": [
            "Síntoma",
            "Que comprobar"
          ],
          "rows": [
            [
              "La dirección del servicio no se abre.",
              "Compruebe que el servicio web se esté ejecutando y que el puerto sea correcto. 127.0.0.1 significa la computadora que ejecuta el navegador; un dispositivo diferente necesita su propia dirección accesible."
            ],
            [
              "La página se abre, pero la extensión no puede conectarse.",
              "Verifique la dirección raíz, el permiso de acceso al navegador y si su versión MTU proporciona puntos finales de inicio de sesión de cuenta y traducción de imágenes compatibles."
            ],
            [
              "Se requieren credenciales incorrectas o cambio de contraseña inicial",
              "Inicie sesión en MTU o cambie la contraseña inicial allí y luego vuelva a conectarse. Utilice credenciales MTU, no una contraseña NodeLane ni una clave del modelo API."
            ],
            [
              "Una conexión anterior ahora informa un inicio de sesión caducado",
              "Elija Reconectar en la configuración del canal. Con la misma dirección de servicio y el mismo nombre de usuario, deje la contraseña en blanco para reutilizarla. Vuelva a introducirla si cambia la dirección o el nombre de usuario, si la contraseña ha cambiado o ya no es válida, o si un perfil antiguo solo contiene un token. La extensión no reenvía silenciosamente la traducción anterior. Guardar la contraseña y reconectar con el campo vacío requiere la extensión 0.10.2 o posterior; en versiones anteriores debes introducirla en cada reconexión."
            ],
            [
              "Conectado, pero la traducción sigue esperando",
              "Verifique las descargas de modelos, la carga del motor, las colas, el saldo API y los recursos de hardware. Pruebe la misma configuración en MTU. La conexión solo verifica el inicio de sesión."
            ],
            [
              "Interrumpido, agotado o devuelto algo que no sea una imagen",
              "Verifique la tarea MTU, el tiempo de espera del proxy y la respuesta. Vuelva a intentar la página fallida manualmente después de solucionar la causa. La extensión no restaura los resultados automáticamente del historial de MTU."
            ]
          ]
        }
      },
      {
        "title": "Caché, uso sin conexión y dónde van las imágenes",
        "paragraphs": [
          "Los resultados del canal local se almacenan en caché en el almacenamiento local de este navegador. Borrar el caché o establecer el presupuesto del caché de imágenes traducidas en cero y cerrar las páginas que aún contienen resultados puede eliminarlos. Los resultados faltantes requieren una retraducción manual; la extensión no puede recuperarlos de MTU.",
          "Las imágenes van al servicio MTU seleccionado. La ejecución de MTU localmente no garantiza la traducción fuera de línea: los traductores en línea, OCR o modelos de imágenes pueden enviar texto o imágenes a sus proveedores. La generación fuera de línea requiere originales disponibles, modelos descargados y una canalización sin dependencias en línea."
        ],
        "links": [
          {
            "label": "Traducción de manga local: costos, privacidad y requisitos fuera de línea",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Elegir un traductor de manga local para leer en el navegador",
    "description": "Conecta manga-translator-ui a tu lector de manga: cuentas, costes, privacidad y requisitos para traducir sin conexión, con archivos locales, EPUB y fuentes compatibles.",
    "category": "Guía de traducción local.",
    "minutes": 6,
    "published": "2026-09-28",
    "updated": "2026-10-04",
    "related": [
      "local-translation",
      "translation-modes",
      "local-comics"
    ],
    "sections": [
      {
        "title": "La traducción de manga necesita un flujo de trabajo de imágenes",
        "paragraphs": [
          "El diálogo en el manga suele ser parte de la obra de arte. La traducción de texto de un navegador no puede devolver directamente las palabras traducidas a los bocadillos. La traducción de imágenes clásica detecta texto, lo lee con OCR, lo traduce, elimina las letras originales y presenta el resultado.",
          "Si ya tiene una computadora capaz de ejecutar un servicio de traducción, puede usar manga-translator-ui para el procesamiento de imágenes y NodeLane Comics para la lectura continua del navegador. La extensión envía imágenes desde la ventana de lectura actual al servicio seleccionado y muestra las traducciones devueltas en su lugar."
        ]
      },
      {
        "title": "Lectura local, un servicio local y traducción fuera de línea.",
        "paragraphs": [
          "\"Local\" puede describir dónde reside un archivo o dónde se ejecuta un servicio. Siga toda la ruta de procesamiento para comprender qué sucede con el contenido."
        ],
        "table": {
          "headers": [
            "Término",
            "lo que significa"
          ],
          "rows": [
            [
              "Lectura de cómics locales",
              "Importa archivos compatibles CBZ/ZIP, CBR/RAR, PDF y MOBI o EPUB sin DRM. EPUB conserva la lectura del documento; solo se traducen sus imágenes de mapa de bits integradas, no el texto del libro ni los elementos vectoriales. No se importan imágenes sueltas, archivos KF8/AZW3 independientes ni libros cifrados. Los sitios necesitan un adaptador dedicado."
            ],
            [
              "Un servicio local MTU",
              "Las imágenes van a su instalación MTU, que puede utilizar modelos locales o API externas."
            ],
            [
              "Traducción completamente fuera de línea",
              "Los originales, modelos y dependencias están disponibles localmente y cada etapa de procesamiento funciona sin servicios en línea. Verifique todo el proceso usted mismo."
            ]
          ]
        }
      },
      {
        "title": "¿MTU autohospedado o el canal oficial?",
        "paragraphs": [
          "Un canal local es adecuado para los lectores que ya ejecutan MTU o desean mantener sus propios modelos y servicios. El canal oficial reduce la configuración y el mantenimiento. Pruebe algunas páginas con cualquiera de las opciones antes de juzgar los resultados."
        ],
        "table": {
          "headers": [
            "Consideración",
            "Tu canal MTU",
            "Canal oficial NodeLane"
          ],
          "rows": [
            [
              "cuenta",
              "MTU credenciales; sin NodeLane iniciar sesión",
              "NodeLane se requiere iniciar sesión"
            ],
            [
              "Configuración",
              "Instala, ejecuta y configura tu servicio",
              "Servicio de traducción mantenido por NodeLane"
            ],
            [
              "Modos de extensión",
              "Actualmente solo traducción clásica",
              "Traducción estándar en la extensión"
            ],
            [
              "Costos",
              "No se utiliza ningún subsidio oficial; El hardware, la potencia y las API elegidas son suyas.",
              "Planes oficiales y reglas de asignación."
            ],
            [
              "Falta caché de resultados",
              "Se requiere retraducción manual",
              "Los resultados oficiales elegibles se pueden descargar nuevamente mientras estén disponibles"
            ]
          ]
        },
        "links": [
          {
            "label": "Conecta tu servicio local",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Planes oficiales y asignaciones.",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "¿La traducción de manga local es gratuita? ¿Qué GPU necesitas?",
        "paragraphs": [
          "Las traducciones de MTU no consumen la asignación oficial de NodeLane, pero eso no significa que todo el flujo de trabajo sea gratuito. Los modelos en línea pueden cobrar por solicitud; Los modelos locales necesitan hardware, almacenamiento y tiempo de procesamiento. Verifique los motores elegidos antes de estimar los costos.",
          "No existe un requisito de memoria único para cada configuración. Los modelos, la resolución de la imagen, OCR y los motores de pintura afectan el uso de recursos y el tiempo de procesamiento. Siga las instrucciones de instalación de MTU para su sistema operativo y hardware, luego pruebe una página clara. No se promete ninguna velocidad fija ni compatibilidad de hardware universal."
        ],
        "links": [
          {
            "label": "Guías oficiales de instalación y proyecto MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Consulta manga japonés, cómics coreanos y tiras largas.",
        "paragraphs": [
          "Comience con un original claro y verifique si el OCR configurado admite su idioma. Los diálogos verticales, los efectos escritos a mano, los fondos complejos y los escaneos de baja resolución pueden provocar que falte texto. Las franjas verticales grandes también pueden consumir más memoria y tiempo.",
          "Elija un idioma de destino disponible y compare una o dos páginas traducidas con los originales. Verifique omisiones, nombres, tono y diseño de burbujas. Los resultados dependen de los modelos y la configuración en MTU; una conexión local no mejora por sí sola la precisión de la traducción."
        ]
      },
      {
        "title": "¿Dónde se cargan las imágenes y qué funciona sin conexión?",
        "paragraphs": [
          "Con MTU seleccionado, la extensión envía imágenes de traducción directamente a ese servicio configurado en lugar de a través del servicio de traducción oficial de NodeLane. Si MTU reenvía texto o imágenes a un proveedor de modelos depende de sus motores habilitados.",
          "Los cómics locales importados y las traducciones en caché siguen siendo legibles mientras esos recursos estén disponibles. Generar nuevas traducciones fuera de línea requiere un servicio local en ejecución y un proceso de procesamiento completamente fuera de línea. Los originales del sitio web también deben almacenarse en caché con antelación. Mantener cachés de resultados reduce el trabajo repetido, pero un caché no es una copia de seguridad permanente."
        ],
        "links": [
          {
            "label": "Cargas de imágenes y permisos de extensión.",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Comience con una página",
        "paragraphs": [
          "Inicie el servicio web de MTU y traduzca una imagen en su propia interfaz. Luego agregue la dirección de servicio y la cuenta en la configuración NodeLane, conéctese y seleccione la traducción clásica y un idioma de destino.",
          "Si la conexión falla, verifique la dirección y el permiso del navegador. Si el inicio de sesión funciona pero no aparece ninguna imagen, verifique la configuración de traducción del servicio. Una pequeña prueba le dice más sobre la idoneidad para la lectura diaria que una afirmación general de velocidad."
        ],
        "links": [
          {
            "label": "Siga el tutorial de traducción local",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Descarga el lector y traductor de cómics",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
