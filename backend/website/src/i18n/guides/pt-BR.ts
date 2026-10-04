import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Tradução local de mangá: conecte manga-translator-ui a NodeLane",
    "description": "Configure o serviço Web manga-translator-ui, conecte-o ao NodeLane e traduza sua primeira página de quadrinhos. Inclui conexão, login, espera e solução de problemas de cache.",
    "category": "Tutorial de tradução local",
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
        "title": "Antes de começar",
        "paragraphs": [
          "NodeLane Comics lida com a leitura em seu navegador; manga-translator-ui (MTU) processa as imagens. Seu próprio canal MTU não precisa de conta NodeLane e não usa permissão oficial de tradução. Hardware, modelos e custos API de terceiros permanecem seus.",
          "Você precisa da extensão mais recente do navegador de desktop, um serviço MTU instalado com suas dependências e o nome de usuário e a senha desse serviço. Este tutorial usa http://127.0.0.1:8000 no mesmo computador que o navegador. Use sua porta real se for diferente."
        ],
        "links": [
          {
            "label": "Baixar NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Instalação oficial do MTU: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Instalação oficial do MTU: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Inicie o serviço da Web MTU",
        "paragraphs": [
          "A extensão precisa de um serviço Web HTTP. Abrir apenas a janela da área de trabalho MTU não é suficiente. Após instalar MTU, execute este comando no diretório do projeto e mantenha o serviço em execução. Ignore este comando se você já executa o serviço Web por meio do Docker ou outro método.",
          "Este exemplo não permite o processamento de GPU. Adicione --use-gpu somente após configurar um ambiente de GPU compatível conforme descrito no upstream. Os requisitos de modelo, driver e hardware dependem da sua versão MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Instruções oficiais de lançamento da Web MTU",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Traduza uma imagem de teste em MTU primeiro",
        "paragraphs": [
          "Abra http://127.0.0.1:8000 em seu navegador, conclua a configuração da conta de MTU e faça login. Se for necessária uma alteração inicial de senha, conclua-a em MTU antes de conectar a extensão. Estas são credenciais MTU, separadas da sua conta NodeLane.",
          "Configure o tradutor, os modelos e quaisquer chaves API necessárias no servidor e, em seguida, confirme se uma imagem de teste produz uma imagem traduzida. A extensão define o idioma de destino e usa padrões do servidor para outras configurações de tradução. Certifique-se de que o serviço Web use os padrões pretendidos. Não insira uma chave modelo API no campo de senha do ramal."
        ],
        "links": [
          {
            "label": "Projeto e documentação oficial MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Adicione um canal de tradução na extensão",
        "paragraphs": [
          "Após conectar, a senha e o token do MTU ficam salvos localmente neste computador. Com o mesmo endereço de serviço e nome de usuário, deixe a senha em branco para reutilizar a salva. Digite-a novamente se o endereço, usuário ou senha mudar, se ela deixar de ser válida ou se um perfil antigo contiver apenas um token. Salvar a senha e reconectar com o campo em branco requer a extensão 0.10.2 ou posterior; nas versões anteriores, digite a senha em cada reconexão."
        ],
        "steps": [
          "Escolha Adicionar canal de tradução e confirme manga-translator-ui como o serviço. Opcionalmente, atribua um nome reconhecível, como “Meu computador”.",
          "Insira http://127.0.0.1:8000 como endereço de serviço. Use a raiz do serviço, sem /auth/login, /translate/with-form/image ou caminho de página de administração.",
          "Digite seu usuário e senha do MTU e escolha Conectar e usar. Confira as restrições de acesso a esse endereço nas configurações do navegador.",
          "Verifique se o canal atual mostra o novo serviço. Você pode salvar vários perfis de serviço, mas apenas o canal selecionado será usado por vez."
        ]
      },
      {
        "title": "4. Leia sua primeira página traduzida",
        "paragraphs": [
          "Importe um mangá local ou abra uma fonte compatível no leitor. Escolha um idioma e a tradução clássica com seu canal MTU selecionado. A extensão atual oferece apenas essa tradução; o redesenho por IA do espaço web é uma função separada.",
          "A página atual tem prioridade, seguida de uma janela limitada de imagens próximas. As imagens são processadas uma por vez no mesmo canal MTU. Compare original e tradução sem perder sua posição; o leitor e a tradução na página usam o mesmo serviço selecionado.",
          "Se uma página falhar, resolva o problema relatado antes de tentar novamente manualmente. Fechar uma página ou perder a conexão não prova que MTU parou de computar. Evite envios repetidos enquanto o serviço ainda estiver ocupado."
        ],
        "links": [
          {
            "label": "Importando quadrinhos locais e formatos suportados",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Solucionar problemas de conexões, login e longas esperas",
        "paragraphs": [
          "Verifique o próprio MTU antes de tentar novamente na extensão. Não compartilhe senhas, tokens ou arquivos privados de quadrinhos ao relatar um problema."
        ],
        "table": {
          "headers": [
            "Sintoma",
            "O que verificar"
          ],
          "rows": [
            [
              "O endereço do serviço não abre",
              "Verifique se o serviço Web está em execução e se a porta está correta. 127.0.0.1 significa o computador que executa o navegador; um dispositivo diferente precisa de seu próprio endereço acessível."
            ],
            [
              "A página é aberta, mas a extensão não consegue se conectar",
              "Verifique o endereço raiz, a permissão de acesso do navegador e se sua versão MTU fornece login de conta compatível e pontos de extremidade de tradução de imagem."
            ],
            [
              "Credenciais erradas ou alteração de senha inicial necessária",
              "Faça login em MTU ou altere a senha inicial e reconecte. Use credenciais MTU, não uma senha NodeLane ou chave modelo API."
            ],
            [
              "Uma conexão anterior agora informa um login expirado",
              "Escolha Reconectar nas configurações do canal. Com o mesmo endereço de serviço e nome de usuário, deixe a senha em branco para reutilizá-la. Digite-a novamente se o endereço ou o nome de usuário mudar, se a senha tiver sido alterada ou não for mais válida, ou se um perfil antigo contiver apenas um token. A extensão não reenvia silenciosamente a tradução anterior. Salvar a senha e reconectar com o campo em branco requer a extensão 0.10.2 ou posterior; nas versões anteriores, digite a senha em cada reconexão."
            ],
            [
              "Conectado, mas a tradução continua esperando",
              "Verifique downloads de modelos, carregamento do motor, filas, equilíbrio API e recursos de hardware. Teste a mesma configuração em MTU. A conexão apenas verifica o login."
            ],
            [
              "Interrompido, expirou ou retornou algo diferente de uma imagem",
              "Verifique a tarefa MTU, o tempo limite do proxy e a resposta. Tente novamente a página com falha manualmente após corrigir a causa. A extensão não restaura resultados automaticamente do histórico MTU."
            ]
          ]
        }
      },
      {
        "title": "Cache, uso offline e para onde vão as imagens",
        "paragraphs": [
          "Os resultados do canal local são armazenados em cache no armazenamento local deste navegador. Limpar o cache ou definir o orçamento do cache de imagens traduzidas como zero e fechar páginas que ainda contêm resultados pode removê-los. Os resultados ausentes exigem retradução manual; a extensão não pode recuperá-los de MTU.",
          "As imagens vão para o serviço MTU selecionado. Executar MTU localmente não garante tradução offline: tradutores online, OCR ou modelos de imagem podem enviar texto ou imagens para seus provedores. A geração offline requer originais disponíveis, modelos baixados e um pipeline sem dependências online."
        ],
        "links": [
          {
            "label": "Tradução local de mangá: custos, privacidade e requisitos offline",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Escolhendo um tradutor local de mangá para leitura no navegador",
    "description": "Conecte manga-translator-ui ao seu leitor: contas, custos, privacidade e requisitos para tradução offline, com arquivos locais, EPUB e fontes compatíveis.",
    "category": "Guia de tradução local",
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
        "title": "A tradução de mangá precisa de um fluxo de trabalho de imagem",
        "paragraphs": [
          "O diálogo no mangá geralmente faz parte da obra de arte. A tradução de texto de um navegador não pode colocar palavras traduzidas diretamente em balões de fala. A tradução clássica de imagens detecta o texto, lê-o com OCR, traduz, remove as letras originais e apresenta o resultado.",
          "Se você já possui um computador capaz de executar um serviço de tradução, pode usar manga-translator-ui para processamento de imagens e NodeLane Comics para leitura contínua do navegador. A extensão envia imagens da janela de leitura atual para o serviço selecionado e exibe as traduções retornadas no local."
        ]
      },
      {
        "title": "Leitura local, serviço local e tradução offline",
        "paragraphs": [
          "“Local” pode descrever onde um arquivo reside ou onde um serviço é executado. Siga todo o caminho de processamento para entender o que acontece com o conteúdo."
        ],
        "table": {
          "headers": [
            "Prazo",
            "O que isso significa"
          ],
          "rows": [
            [
              "Leitura de quadrinhos local",
              "Importe arquivos compatíveis CBZ/ZIP, CBR/RAR, PDF e MOBI ou EPUB sem DRM. O EPUB mantém a leitura do documento; apenas suas imagens raster incorporadas são traduzidas, não o texto do livro nem elementos vetoriais. Imagens avulsas, arquivos KF8/AZW3 independentes e livros criptografados não são importados. Sites precisam de um adaptador dedicado."
            ],
            [
              "Um serviço MTU local",
              "As imagens vão para a instalação do MTU, que pode usar modelos locais ou APIs externas."
            ],
            [
              "Tradução totalmente offline",
              "Originais, modelos e dependências estão disponíveis localmente e todas as etapas de processamento funcionam sem serviços online. Verifique você mesmo todo o pipeline."
            ]
          ]
        }
      },
      {
        "title": "MTU auto-hospedado ou canal oficial?",
        "paragraphs": [
          "Um canal local é adequado para leitores que já administram MTU ou desejam manter seus próprios modelos e serviços. O canal oficial reduz configuração e manutenção. Experimente algumas páginas com qualquer uma das opções antes de julgar os resultados."
        ],
        "table": {
          "headers": [
            "Consideração",
            "Seu canal MTU",
            "Canal oficial NodeLane"
          ],
          "rows": [
            [
              "Conta",
              "MTU credenciais; sem login NodeLane",
              "NodeLane login necessário"
            ],
            [
              "Configuração",
              "Instale, execute e configure seu serviço",
              "Serviço de tradução mantido por NodeLane"
            ],
            [
              "Modos de extensão",
              "Atualmente apenas tradução clássica",
              "A extensão atual oferece apenas tradução clássica. O redesenho por IA descrito aqui pertence ao espaço web de tradução de imagens, conforme os direitos disponíveis."
            ],
            [
              "Custos",
              "Nenhum subsídio oficial utilizado; hardware, potência e APIs escolhidas são suas",
              "Planos oficiais e regras de subsídio"
            ],
            [
              "Cache de resultados ausente",
              "Retradução manual necessária",
              "Os resultados oficiais elegíveis podem ser baixados novamente enquanto estiverem disponíveis"
            ]
          ]
        },
        "links": [
          {
            "label": "Conecte seu serviço local",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Planos e subsídios oficiais",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "A tradução local de mangá é gratuita? Qual GPU você precisa?",
        "paragraphs": [
          "As traduções de MTU não consomem a verba oficial de NodeLane, mas isso não torna todo o fluxo de trabalho gratuito. Os modelos online podem cobrar por solicitação; modelos locais precisam de hardware, armazenamento e tempo de processamento. Verifique os motores escolhidos antes de estimar os custos.",
          "Não há um requisito único de memória para cada configuração. Modelos, resolução de imagem, OCR e mecanismos de pintura afetam o uso de recursos e o tempo de processamento. Siga as orientações de instalação de MTU para seu sistema operacional e hardware e teste uma página limpa. Nenhuma velocidade fixa ou compatibilidade universal de hardware é prometida."
        ],
        "links": [
          {
            "label": "Guias oficiais de projeto e instalação MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Confira mangás japoneses, quadrinhos coreanos e tiras longas",
        "paragraphs": [
          "Comece com um original claro e verifique se o OCR configurado suporta seu idioma. Diálogos verticais, efeitos manuscritos, planos de fundo complexos e digitalizações de baixa resolução podem causar falta de texto. Faixas verticais grandes também podem consumir mais memória e tempo.",
          "Escolha um idioma de destino disponível e compare uma ou duas páginas traduzidas com as originais. Verifique omissões, nomes, tom e layout das bolhas. Os resultados dependem dos modelos e configurações em MTU; uma conexão local por si só não melhora a precisão da tradução."
        ]
      },
      {
        "title": "Onde as imagens são carregadas e o que funciona offline?",
        "paragraphs": [
          "Com MTU selecionado, a extensão envia imagens de tradução diretamente para esse serviço configurado, em vez de por meio do serviço de tradução oficial de NodeLane. Se MTU encaminha texto ou imagens para um provedor de modelo depende de seus mecanismos habilitados.",
          "Quadrinhos locais importados e traduções em cache permanecem legíveis enquanto esses recursos estiverem disponíveis. A geração de novas traduções offline requer um serviço local em execução e um pipeline de processamento totalmente offline. Os originais do site também devem ser armazenados em cache com antecedência. Manter caches de resultados reduz o trabalho repetido, mas um cache não é um backup permanente."
        ],
        "links": [
          {
            "label": "Uploads de imagens e permissões de extensão",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Comece com uma página",
        "paragraphs": [
          "Inicie o serviço Web do MTU e traduza uma imagem em sua própria interface. Em seguida, adicione o endereço de serviço e a conta nas configurações de NodeLane, conecte-se e selecione a tradução clássica e um idioma de destino.",
          "Se a conexão falhar, verifique o endereço e a permissão do navegador. Se o login funcionar, mas nenhuma imagem aparecer, verifique a configuração de tradução do serviço. Um pequeno teste diz mais sobre a adequação para a leitura diária do que uma afirmação geral de velocidade."
        ],
        "links": [
          {
            "label": "Siga o tutorial de tradução local",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Baixe o leitor e tradutor de quadrinhos",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
