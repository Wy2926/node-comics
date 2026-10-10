import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Bản dịch truyện tranh cục bộ: kết nối manga-translator-ui với NodeLane",
    "description": "Thiết lập dịch vụ Web manga-translator-ui, kết nối nó với NodeLane và dịch trang truyện tranh đầu tiên của bạn. Bao gồm kết nối, đăng nhập, chờ đợi và xử lý sự cố bộ đệm.",
    "category": "Hướng dẫn dịch thuật cục bộ",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-10-08",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Trước khi bạn bắt đầu",
        "paragraphs": [
          "NodeLane Comics xử lý việc đọc trong trình duyệt của bạn; manga-translator-ui (MTU) xử lý hình ảnh. Kênh MTU của riêng bạn không cần tài khoản NodeLane và không sử dụng hạn mức dịch chính thức. Phần cứng, mô hình và chi phí API của bên thứ ba vẫn là của bạn.",
          "Bạn cần có tiện ích mở rộng trình duyệt dành cho máy tính để bàn mới nhất, dịch vụ MTU đã cài đặt cùng với các phần phụ thuộc của nó cũng như tên người dùng và mật khẩu của dịch vụ đó. Hướng dẫn này sử dụng http://127.0.0.1:8000 trên cùng một máy tính với trình duyệt. Sử dụng cổng thực tế của bạn nếu nó khác."
        ],
        "links": [
          {
            "label": "Tải xuống NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Cài đặt MTU chính thức: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Cài đặt MTU chính thức: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Khởi động dịch vụ web MTU",
        "paragraphs": [
          "Tiện ích mở rộng cần có dịch vụ Web HTTP. Chỉ mở cửa sổ màn hình MTU thôi là chưa đủ. Sau khi cài đặt MTU, hãy chạy lệnh này trong thư mục dự án và tiếp tục chạy dịch vụ. Bỏ qua lệnh này nếu bạn đã chạy dịch vụ Web thông qua Docker hoặc phương pháp khác.",
          "Ví dụ này không bật xử lý bằng GPU. Chỉ thêm --use-gpu sau khi thiết lập môi trường GPU được hỗ trợ theo tài liệu chính thức. Yêu cầu về mô hình, trình điều khiển và phần cứng phụ thuộc vào phiên bản MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "MTU Hướng dẫn ra mắt trang web chính thức",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Dịch một ảnh thử ngay trong MTU trước",
        "paragraphs": [
          "Mở http://127.0.0.1:8000 trong trình duyệt của bạn, hoàn tất thiết lập tài khoản của MTU và đăng nhập. Nếu yêu cầu thay đổi mật khẩu ban đầu, hãy hoàn tất việc đó trong MTU trước khi kết nối tiện ích mở rộng. Đây là thông tin xác thực MTU, tách biệt với tài khoản NodeLane của bạn.",
          "Cấu hình bộ dịch, mô hình và các khóa API cần thiết trên máy chủ, rồi kiểm tra xem ảnh thử có cho ra bản dịch không. Tiện ích đặt ngôn ngữ đích và dùng cấu hình mặc định của máy chủ cho các tùy chọn khác. Hãy bảo đảm dịch vụ Web dùng đúng mặc định bạn muốn. Không nhập khóa API của mô hình vào ô mật khẩu trong tiện ích."
        ],
        "links": [
          {
            "label": "Dự án và tài liệu chính thức MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Thêm kênh dịch trong tiện ích mở rộng",
        "paragraphs": [
          "Mở cài đặt của tiện ích mở rộng và tìm Kênh dịch. Sau khi kết nối thành công, tiện ích lưu mật khẩu và mã thông báo dịch vụ trên máy tính này. Khi kết nối lại với cùng địa chỉ dịch vụ và tên người dùng, bạn có thể để trống ô mật khẩu để dùng mật khẩu đã lưu. Nếu đổi địa chỉ hoặc tên người dùng, hoặc mật khẩu đã thay đổi hay không còn hợp lệ, hãy nhập lại mật khẩu. Các nhãn bên dưới mô tả các điều khiển tương ứng bằng ngôn ngữ giao diện của bạn. Lưu mật khẩu và kết nối lại với ô mật khẩu để trống cần tiện ích phiên bản 0.10.2 trở lên; ở phiên bản cũ hơn, bạn phải nhập mật khẩu mỗi lần kết nối lại."
        ],
        "steps": [
          "Chọn Thêm kênh dịch và xác nhận manga-translator-ui làm dịch vụ. Tùy ý đặt cho nó một cái tên dễ nhận biết, chẳng hạn như “Máy tính của tôi”.",
          "Nhập http://127.0.0.1:8000 làm địa chỉ dịch vụ. Sử dụng root dịch vụ, không có /auth/login, /translate/with-form/image hoặc đường dẫn trang quản trị.",
          "Nhập tên người dùng và mật khẩu MTU, sau đó chọn Kết nối và sử dụng. Kết nối không xin quyền website riêng; nếu truy cập bị giới hạn, hãy khôi phục quyền truy cập tất cả website trong phần cài đặt tiện ích rồi thử lại.",
          "Kiểm tra xem Kênh hiện tại có hiển thị dịch vụ mới không. Bạn có thể lưu nhiều cấu hình dịch vụ nhưng mỗi lần chỉ sử dụng kênh đã chọn."
        ]
      },
      {
        "title": "4. Đọc trang dịch đầu tiên của bạn",
        "paragraphs": [
          "Nhập truyện cục bộ hoặc EPUB, hay mở website tương thích và OPDS trong trình đọc. Chọn ngôn ngữ, dịch và kiểm tra ảnh hiện tại. Cả kênh NodeLane lẫn MTU trong tiện ích đều dịch hình ảnh; EPUB không dịch văn bản.",
          "Ảnh hiện tại được ưu tiên rồi bổ sung vùng lân cận có giới hạn theo vị trí đọc. Cùng một MTU xử lý lần lượt từng ảnh. Chuyển hoặc so sánh bản gốc giữ vị trí; dịch tab, ảnh nhấp chuột phải và vùng chọn cũng dùng kênh hiện tại.",
          "Nếu một trang bị lỗi, hãy giải quyết vấn đề được báo cáo trước khi thử lại theo cách thủ công. Việc đóng một trang hoặc mất kết nối không chứng tỏ rằng MTU đã ngừng tính toán. Tránh gửi đi lặp lại trong khi dịch vụ có thể vẫn đang bận."
        ],
        "links": [
          {
            "label": "Nhập truyện tranh cục bộ và các định dạng được hỗ trợ",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Khắc phục sự cố kết nối, đăng nhập và chờ đợi lâu",
        "paragraphs": [
          "Hãy kiểm tra chính MTU trước khi thử lại trong tiện ích mở rộng. Không chia sẻ mật khẩu, mã thông báo hoặc tệp truyện tranh riêng tư khi báo cáo sự cố."
        ],
        "table": {
          "headers": [
            "triệu chứng",
            "Những gì cần kiểm tra"
          ],
          "rows": [
            [
              "Địa chỉ dịch vụ không mở",
              "Kiểm tra xem dịch vụ Web có đang chạy không và cổng có đúng không. 127.0.0.1 nghĩa là máy tính chạy trình duyệt; một thiết bị khác cần có địa chỉ có thể truy cập được của riêng nó."
            ],
            [
              "Trang mở ra nhưng tiện ích mở rộng không thể kết nối",
              "Kiểm tra địa chỉ gốc, quyền truy cập trình duyệt và xem phiên bản MTU của bạn có cung cấp điểm cuối dịch hình ảnh và đăng nhập tài khoản tương thích hay không."
            ],
            [
              "Yêu cầu thông tin đăng nhập sai hoặc thay đổi mật khẩu ban đầu",
              "Đăng nhập vào MTU hoặc thay đổi mật khẩu ban đầu ở đó, sau đó kết nối lại. Sử dụng thông tin đăng nhập MTU, không phải mật khẩu NodeLane hoặc khóa API mẫu."
            ],
            [
              "Kết nối trước đó hiện báo cáo thông tin đăng nhập đã hết hạn",
              "Chọn Kết nối lại trong cài đặt kênh. Với cùng địa chỉ dịch vụ và tên người dùng, bạn có thể để trống ô mật khẩu để dùng mật khẩu đã lưu. Cấu hình từ phiên bản cũ chỉ lưu mã thông báo cần nhập mật khẩu một lần khi kết nối lại lần đầu. Nếu đổi địa chỉ hoặc tên người dùng, hoặc mật khẩu đã thay đổi hay không còn hợp lệ, hãy nhập lại mật khẩu. Tiện ích mở rộng không âm thầm gửi lại bản dịch trước đó. Lưu mật khẩu và kết nối lại với ô mật khẩu để trống cần tiện ích phiên bản 0.10.2 trở lên; ở phiên bản cũ hơn, bạn phải nhập mật khẩu mỗi lần kết nối lại."
            ],
            [
              "Đã kết nối nhưng bản dịch vẫn đang chờ",
              "Kiểm tra tải xuống mô hình, tải động cơ, hàng đợi, số dư API và tài nguyên phần cứng. Kiểm tra cấu hình tương tự trong MTU. Kết nối chỉ xác minh đăng nhập."
            ],
            [
              "Bị gián đoạn, hết thời gian hoặc trả lại nội dung nào đó không phải là hình ảnh",
              "Kiểm tra tác vụ MTU, thời gian chờ proxy và phản hồi. Hãy thử lại trang bị lỗi theo cách thủ công sau khi khắc phục được nguyên nhân. Tiện ích mở rộng không tự động khôi phục kết quả từ lịch sử MTU."
            ]
          ]
        }
      },
      {
        "title": "Bộ nhớ đệm, sử dụng ngoại tuyến và nơi hình ảnh đi",
        "paragraphs": [
          "Kết quả kênh cục bộ được lưu vào bộ nhớ cục bộ của trình duyệt này. Việc xóa bộ nhớ đệm hoặc đặt ngân sách bộ nhớ đệm hình ảnh đã dịch về 0 và đóng các trang vẫn giữ kết quả có thể xóa chúng. Kết quả bị thiếu cần phải dịch lại bằng tay; tiện ích mở rộng không thể tìm nạp lại chúng từ MTU.",
          "Hình ảnh được chuyển đến dịch vụ MTU đã chọn. Chạy MTU cục bộ không đảm bảo dịch ngoại tuyến: người dịch trực tuyến, OCR hoặc mô hình hình ảnh có thể gửi văn bản hoặc hình ảnh đến nhà cung cấp của họ. Tạo ngoại tuyến yêu cầu bản gốc có sẵn, mô hình đã tải xuống và quy trình không có phụ thuộc trực tuyến."
        ],
        "links": [
          {
            "label": "Dịch truyện tranh cục bộ: chi phí, quyền riêng tư và yêu cầu ngoại tuyến",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Chọn một dịch giả truyện tranh cục bộ để đọc trên trình duyệt",
    "description": "Sử dụng manga-translator-ui với trình đọc truyện tranh trên trình duyệt: hiểu bản dịch truyện tranh cục bộ, phần cứng và chi phí API, quyền riêng tư, yêu cầu ngoại tuyến và hỗ trợ đọc CBZ và PDF.",
    "category": "Hướng dẫn dịch cục bộ",
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
        "title": "Dịch manga cần một quy trình làm việc bằng hình ảnh",
        "paragraphs": [
          "Đối thoại trong manga thường là một phần của tác phẩm nghệ thuật. Bản dịch văn bản của trình duyệt không thể trực tiếp đưa các từ đã dịch trở lại ô lời thoại. Dịch hình ảnh phát hiện văn bản, đọc nó bằng OCR, dịch nó, xóa chữ gốc và đưa ra kết quả.",
          "Nếu bạn đã có máy tính có khả năng chạy dịch vụ dịch thuật, bạn có thể sử dụng manga-translator-ui để xử lý hình ảnh và NodeLane Comics để đọc trình duyệt liên tục. Tiện ích mở rộng sẽ gửi hình ảnh từ cửa sổ đọc hiện tại đến dịch vụ đã chọn và hiển thị các bản dịch được trả về tại chỗ."
        ]
      },
      {
        "title": "Đọc cục bộ, dịch vụ cục bộ và dịch ngoại tuyến",
        "paragraphs": [
          "“Cục bộ” có thể mô tả nơi tệp tồn tại hoặc nơi dịch vụ chạy. Thực hiện theo toàn bộ quá trình xử lý để hiểu điều gì xảy ra với nội dung."
        ],
        "table": {
          "headers": [
            "kỳ hạn",
            "Nó có nghĩa là gì"
          ],
          "rows": [
            [
              "Đọc truyện tranh cục bộ",
              "Nhập CBZ/ZIP, CBR/RAR, PDF, MOBI không DRM tương thích hoặc EPUB. Đọc ảnh và văn bản gốc không cần dịch vụ; EPUB chỉ dịch ảnh trong sách."
            ],
            [
              "Dịch vụ MTU cục bộ",
              "Hình ảnh sẽ được chuyển đến bản cài đặt MTU của bạn, bản cài đặt này có thể sử dụng các mô hình cục bộ hoặc API bên ngoài."
            ],
            [
              "Bản dịch hoàn toàn ngoại tuyến",
              "Bản gốc, mô hình và phần phụ thuộc đều có sẵn tại cục bộ và mọi giai đoạn xử lý đều hoạt động mà không cần dịch vụ trực tuyến. Hãy tự mình xác minh toàn bộ đường ống."
            ]
          ]
        }
      },
      {
        "title": "MTU tự lưu trữ hay kênh chính thức?",
        "paragraphs": [
          "Kênh cục bộ phù hợp với những độc giả đã chạy MTU hoặc muốn duy trì mô hình và dịch vụ của riêng họ. Kênh chính thức giảm thiểu việc thiết lập và bảo trì. Hãy thử một vài trang với một trong hai tùy chọn trước khi đánh giá kết quả."
        ],
        "table": {
          "headers": [
            "Cân nhắc",
            "Kênh MTU của bạn",
            "Kênh NodeLane chính thức"
          ],
          "rows": [
            [
              "Tài khoản",
              "MTU thông tin xác thực; không có NodeLane đăng nhập",
              "NodeLane yêu cầu đăng nhập"
            ],
            [
              "thiết lập",
              "Cài đặt, chạy và định cấu hình dịch vụ của bạn",
              "Dịch vụ dịch thuật được duy trì bởi NodeLane"
            ],
            [
              "Chi phí",
              "Không sử dụng hạn mức chính thức; phần cứng, sức mạnh và các API đã chọn là của bạn",
              "Kế hoạch chính thức và quy định phụ cấp"
            ],
            [
              "Thiếu bộ đệm kết quả",
              "Cần dịch lại thủ công",
              "Kết quả chính thức đủ điều kiện có thể được tải xuống lại khi có sẵn"
            ]
          ]
        },
        "links": [
          {
            "label": "Kết nối dịch vụ cục bộ của bạn",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Kế hoạch và phụ cấp chính thức",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "Dịch truyện tranh cục bộ có miễn phí không? Bạn cần GPU nào?",
        "paragraphs": [
          "Các bản dịch MTU không tiêu tốn sự hạn mức chính thức của NodeLane, nhưng điều đó không làm cho toàn bộ quy trình làm việc trở nên miễn phí. Các mô hình trực tuyến có thể tính phí theo yêu cầu; các mô hình cục bộ cần phần cứng, thời gian lưu trữ và xử lý. Kiểm tra động cơ bạn đã chọn trước khi ước tính chi phí.",
          "Không có yêu cầu bộ nhớ duy nhất cho mỗi thiết lập. Mô hình, độ phân giải hình ảnh, OCR và công cụ inpainting ảnh hưởng đến việc sử dụng tài nguyên và thời gian xử lý. Làm theo hướng dẫn cài đặt của MTU cho hệ điều hành và phần cứng của bạn, sau đó kiểm tra một trang rõ ràng. Không có tốc độ cố định hoặc khả năng tương thích phần cứng phổ quát nào được hứa hẹn."
        ],
        "links": [
          {
            "label": "Hướng dẫn cài đặt và dự án MTU chính thức",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Kiểm tra truyện tranh Nhật Bản, truyện tranh Hàn Quốc và truyện dài",
        "paragraphs": [
          "Bắt đầu với một bản gốc rõ ràng và kiểm tra xem OCR đã định cấu hình có hỗ trợ ngôn ngữ của nó hay không. Đối thoại dọc, hiệu ứng viết tay, hình nền phức tạp và bản quét có độ phân giải thấp có thể khiến văn bản bị thiếu. Các dải dọc lớn cũng có thể chiếm nhiều bộ nhớ và thời gian hơn.",
          "Chọn ngôn ngữ đích có sẵn và so sánh một hoặc hai trang đã dịch với bản gốc. Kiểm tra thiếu sót, tên, giai điệu và bố cục bong bóng. Kết quả phụ thuộc vào mô hình và cài đặt trong MTU; bản thân kết nối cục bộ không cải thiện độ chính xác của bản dịch."
        ]
      },
      {
        "title": "Hình ảnh được tải lên ở đâu và những gì hoạt động ngoại tuyến?",
        "paragraphs": [
          "Với MTU được chọn, tiện ích mở rộng sẽ gửi hình ảnh dịch trực tiếp đến dịch vụ được định cấu hình đó thay vì thông qua dịch vụ dịch chính thức của NodeLane. Việc MTU có chuyển tiếp văn bản hoặc hình ảnh tới nhà cung cấp mô hình hay không tùy thuộc vào công cụ được kích hoạt của nó.",
          "Truyện tranh cục bộ đã nhập và bản dịch được lưu trong bộ nhớ đệm vẫn có thể đọc được khi những tài nguyên đó có sẵn. Việc tạo bản dịch mới ngoại tuyến yêu cầu dịch vụ cục bộ đang chạy và quy trình xử lý ngoại tuyến hoàn toàn. Bản gốc của trang web cũng phải được lưu trữ trước. Việc giữ bộ nhớ đệm kết quả giúp giảm công việc lặp lại nhưng bộ nhớ đệm không phải là bản sao lưu vĩnh viễn."
        ],
        "links": [
          {
            "label": "Tải lên hình ảnh và quyền mở rộng",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Bắt đầu với một trang",
        "paragraphs": [
          "Khởi động dịch vụ Web của MTU và dịch một hình ảnh trong giao diện của chính nó. Sau đó thêm địa chỉ dịch vụ và tài khoản trong cài đặt NodeLane, kết nối và chọn dịch và ngôn ngữ đích.",
          "Nếu kết nối không thành công, hãy kiểm tra địa chỉ và quyền của trình duyệt. Nếu đăng nhập hoạt động nhưng không có hình ảnh xuất hiện, hãy kiểm tra cấu hình dịch của dịch vụ. Một thử nghiệm nhỏ cho bạn biết nhiều hơn về sự phù hợp cho việc đọc hàng ngày hơn là yêu cầu về tốc độ chung."
        ],
        "links": [
          {
            "label": "Thực hiện theo hướng dẫn dịch thuật cục bộ",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Tải xuống trình đọc và dịch truyện tranh",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
