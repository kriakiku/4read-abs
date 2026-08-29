# 4read-abs

> **Дисклеймер.** Проєкт розроблено в **освітніх** цілях. Його використання може
> порушувати [правила користування](https://4read.org) сайтом 4read.org і застосовне
> законодавство. Використовуйте **виключно в ознайомлювальних цілях**, на свій ризик і
> відповідальність. Автори не заохочують обхід обмежень сайту, масове збирання даних чи
> порушення авторських прав. Інструмент **не завантажує аудіо** — лише метадані з
> відкритих HTML-сторінок.
>
> **Весь код у цьому репозиторії згенеровано штучним інтелектом.** Жодного рядка не
> перевіряв розробник; я без поняття, що там всередині. Не покладайтеся на це в
> продакшені й не вважайте репозиторій рев’юнутим чи безпечним.

Читає метадані аудіокниг із [4read.org](https://4read.org) і синхронізує їх із
[Audiobookshelf](https://www.audiobookshelf.org): жанри, автор, диктор, цикл і номер
тому, обкладинка, опис, тривалість. Можна підписатися на цикл, автора чи диктора —
новинки потрапляють у чергу в простому веб-інтерфейсі (**UI англійською**; назви книг,
автори й описи залишаються українськими, як на джерелі).

Метадані потрапляють у Audiobookshelf як sidecar-файли `metadata.json` і обкладинка
поруч із книгою. Це найвищий локальний пріоритет метаданих у ABS, тож вони перебивають
імена тек і вбудовані теги без плагінів і без push через API.

## Що витягується

Сайт на DataLife Engine з schema.org-мікроданими, тож поля структуровані, а facet-URL
сайту слугують стабільними ідентифікаторами:

| Поле | Джерело | Ідентифікатор |
| --- | --- | --- |
| Жанри | посилання категорій | `/fentezi/` → `fentezi` |
| Автор | `itemprop="author"` | `/xfsearch/avtor/<name>/` |
| Диктор | `itemprop="readBy"` | `/xfsearch/chitaet/<name>/` |
| Цикл і том | `schema.org/PublicationVolume` | `/xfsearch/cikl/<name>/` + `volumeNumber` |
| Обкладинка | `og:image` | — |
| Тривалість, рейтинг | `meta[itemprop="duration"]`, блок рейтингу | — |
| Книга | canonical URL | числовий id, напр. `6840` |

Окремі книги без циклу — нормальний випадок.

Каталог будується з `sitemap.xml` → `news_pages.xml` (у кожного запису є `lastmod`),
тому звичайні синхронізації перечитують лише змінені сторінки. `avtors.html` і
`readers.html` перелічують усіх авторів і дикторів із кількістю книг — після двох
запитів уже можна налаштовувати підписки.

## Cloudflare і FlareSolverr

Увесь сайт за Cloudflare managed challenge. Звичайний HTTP-клієнт отримує `403` на
будь-який шлях, включно з `robots.txt`. Без обходу інструмент нічого не зробить.

Вкажіть `FLARESOLVERR_URL` на інстанс [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr):
він проходить challenge у браузері, а `cf_clearance` перевикористовується для звичайних
запитів. Обкладинки завжди йдуть прямим запитом (FlareSolverr повертає лише HTML); якщо
їх блокує, clearance оновлюється через FlareSolverr і завантаження повторюється.

Режими `FLARESOLVERR_MODE`:

- `auto` (за замовчуванням) — спочатку прямий запит, FlareSolverr лише після challenge
- `always` — усі сторінки через FlareSolverr
- `never` — ніколи не використовувати

Сайт чутливий до сплесків, а не до стабільного темпу: інтервал подвоюється після
challenge, зменшується, коли все спокійно, повторні challenge вмикають довгий cooldown.
Перший повний обхід ~5 000 сторінок займе години; він відновлюваний. Щоденні синхрони
дешеві завдяки `lastmod`.

## Встановлення

### Контейнер (GHCR)

Образи публікуються в GitHub Container Registry workflow’ом **Container** на тегах `v*`:

```bash
docker pull ghcr.io/kriakiku/4read-abs:latest
# або конкретна версія
docker pull ghcr.io/kriakiku/4read-abs:0.1.0
```

Якщо репозиторій приватний, спочатку увійдіть:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin
```

### Docker Compose

Піднімає FlareSolverr разом із сервісом:

```bash
cp config.example.yaml config/config.yaml
# відредагуйте config/config.yaml і шлях до бібліотеки в docker-compose.yml
ABS_URL=http://audiobookshelf:13378 ABS_API_KEY=... docker compose up -d
```

За замовчуванням compose тягне `ghcr.io/kriakiku/4read-abs:latest`. Щоб зібрати з
локальних джерел, розкоментуйте `build: .` у `docker-compose.yml`.

Том `/library` має вказувати на **ту саму** бібліотеку, що й Audiobookshelf, і бути
доступним на запис — метадані доставляються файлами.

### Бінарник

Кожен реліз також публікує self-contained `linux-amd64` виконуваний файл (Bun
всередині):

```bash
curl -fsSLO https://github.com/kriakiku/4read-abs/releases/latest/download/4read-abs-linux-amd64
chmod +x 4read-abs-linux-amd64
cp config.example.yaml config.yaml
./4read-abs-linux-amd64 serve
```

## Інтеграція з Audiobookshelf

Схема роботи:

1. Сервіс збирає каталог 4read і матчить книги з елементами ABS (за тегом `4read:<id>`
   або за нормалізованими автором + назвою).
2. У staging збирається повний набір: `metadata.json` + обкладинка (+ ваші аудіофайли,
   якщо вже лежать у staging).
3. У теку книги в бібліотеці ABS **копіюються** метадані й обкладинка; медіа
   **хардлінкується** (або копіюється, якщо файлові системи різні).
4. Через ABS API викликається rescan одного елемента — ABS підхоплює sidecar.

### Налаштування ABS

1. **Не змінюйте порядок пріоритету метаданих**, якщо немає потреби. Типовий порядок
   (від нижчого до вищого):
   `folderStructure, audioMetatags, nfoFile, txtFiles, opfFile, absMetadata`.
   Файл `metadata.json` (`absMetadata`) має бути **найвищим**. Якщо ви його опускали —
   поверніть нагору в налаштуваннях бібліотеки.
2. **Змонтуйте бібліотеку** в контейнер 4read-abs із правами на запис.
3. **Зіставте шляхи**, якщо ABS бачить інші шляхи, ніж цей процес (як у Sonarr/Radarr):

   ```yaml
   audiobookshelf:
     pathMappings:
       - from: /audiobooks   # шлях всередині ABS
         to: /library        # шлях у контейнері 4read-abs
   ```

4. **Створіть API-ключ** у Audiobookshelf і передайте як `ABS_API_KEY`. API потрібен
   лише щоб перелічити елементи, знайти їхні теки й зробити rescan після запису sidecar.
   Самі метадані **не** пушаться через API — лише файли.

### Політика запису

`sync.writePolicy`:

| Значення | Поведінка |
| --- | --- |
| `fill-empty` | Заповнює лише порожні поля ABS |
| `overwrite-ours` (за замовчуванням) | Перезаписує те, що писали ми раніше; ручні правки в UI ABS зберігаються |
| `overwrite-all` | Завжди пише наші значення |

Кожному елементу ставиться тег `4read:<id>` для точного повторного розпізнавання.
Без тега — матч за нормалізованими назвою й автором (кирилиця й трансліт); нижче
`sync.matchThreshold` — лише ручна прив’язка в веб-UI, без «вгадування».

### Staging і hardlink

Кожна книга спочатку збирається в окремій теці під `STAGING_DIR` і лише потім
публікується в бібліотеку — ABS ніколи не бачить напівзаписану книгу.

- **Медіа** — hardlink (без подвійного зберігання). Якщо ціль на іншій ФС — fallback
  на copy (`sync.onCrossDevice`). Тримайте staging і бібліотеку на одній ФС. Примусово:
  `sync.linkMode: copy`.
- **`metadata.json` і обкладинка завжди копіюються.** ABS перезаписує `metadata.json`
  на місці при ручному редагуванні; hardlink зіпсував би staging-копію.

З увімкненим `sync.createFolders` прийняті з черги книги, яких ще немає в бібліотеці,
отримують теку за `sync.folderTemplate` уже з метаданими й обкладинкою — аудіо можна
додати пізніше.

### Обкладинки в UI

Веб-інтерфейс **не** тягне зображення з 4read.org у браузері (той самий Cloudflare).
Обкладинки віддаються з локального staging-кешу: `/api/covers/<id>?v=…`.

## Конфігурація

Секрети — лише зі змінних оточення (перебивають YAML), щоб редактор у веб-UI ніколи не
зберігав облікові дані:

| Змінна | Призначення |
| --- | --- |
| `ABS_URL`, `ABS_API_KEY` | Сервер Audiobookshelf і API-ключ |
| `ABS_LIBRARY_DIR` | Бібліотека ABS, як її бачить цей процес |
| `FLARESOLVERR_URL`, `FLARESOLVERR_MODE` | Обхід Cloudflare |
| `HARDCOVER_API_KEY` | Опційне збагачення з Hardcover |
| `STAGING_DIR`, `DATA_DIR`, `CONFIG_FILE` | Шляхи |
| `HOST`, `PORT`, `LOG_LEVEL` | Веб-інтерфейс і логи |

Решта — у `config.yaml` (див. `config.example.yaml`), редагується з веб-UI з
валідацією й reload. **Автентифікації немає** — біндіть на loopback
(`127.0.0.1:8480` за замовчуванням; у Docker — `127.0.0.1:8480:8480`).

### Підписки

```yaml
narrators:
  prefer:
    - Характерник
    - Ада Роговцева
  block: []

subscriptions:
  - type: series
    value: "all the young dudes"
  - type: author
    value: "Агата Крісті"
  - type: narrator
    value: "Характерник"
```

Типи: `author`, `narrator`, `series`, `genre`, `tag` — за ідентифікатором або
відображуваною назвою.

Кілька озвучень однієї книги згортаються в один твір (різні форми тома на кшталт
`Книга 2`, `(Т. 2)`, `Частина II` нормалізуються). Пріоритет диктора навмисно вищий за
рейтинг; заблоковані диктори відкидаються, якщо є альтернатива. Книги, що вже є в
бібліотеці, не показуються як новини — для них оновлюються лише метадані.

## Публікація релізів і контейнера

| Подія | Workflow | Результат |
| --- | --- | --- |
| Тег `v*` або ручний запуск | `Release` | Бінарник `4read-abs-linux-amd64` + tar.gz у GitHub Releases |
| Тег `v*` або ручний запуск | `Container` | Образ `ghcr.io/kriakiku/4read-abs:<tag>`, `:latest` і `:<semver>` |

Приклад:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Резервне копіювання

Стан утиліти — це майже лише SQLite і конфіг. Обкладинки й зібране в staging можна
знову отримати з джерела / перезібрати `sync`; аудіо цей інструмент **не** качає й у
бекап 4read-abs включати не потрібно (його зберігаєте окремо з бібліотекою ABS, якщо
взагалі бекапите медіа).

### Що обов’язково зберігати

| Шлях | Навіщо |
| --- | --- |
| `{DATA_DIR}/4read-abs.db` (+ `4read-abs.db-wal`, `4read-abs.db-shm`, якщо є) | Каталог, черга, підписки, зв’язки з ABS, cookie jar Cloudflare, кеш Hardcover |
| `config.yaml` (або том `/config`) | Підписки, політики sync, path mappings |
| Секрети з оточення | `ABS_URL`, `ABS_API_KEY`, `HARDCOVER_API_KEY`, тощо — у менеджері секретів / `.env`, не в git |

Перед копіюванням **зупиніть** сервіс (`docker compose stop 4read-abs` або SIGTERM бінарнику), щоб SQLite у режимі WAL віддав узгоджений знімок. Альтернатива без даунтайму: `sqlite3 data/4read-abs.db ".backup 'backup/4read-abs.db'"`.

### Що можна не бекапити (докачається / перезбереться)

| Шлях | Чому можна пропустити |
| --- | --- |
| увесь `STAGING_DIR` (`./staging`, `/staging`) | Обкладинки й sidecar збираються знову при `sync` / відкритті UI |
| аудіо в бібліотеці ABS (`.m4b`, `.mp3`, `.m4a`, …) | Не частина стану 4read-abs; після відновлення БД sidecar (`metadata.json`, `cover.*`) знову запише `sync` |
| логи контейнера | Не потрібні для відновлення |

### Приклад: архів лише стану утиліти

Docker Compose (томи `./data`, `./config`, `./staging` поруч із compose-файлом):

```bash
docker compose stop 4read-abs

# Конфіг + SQLite; staging і будь-які медіа виключені.
tar -czf 4read-abs-state-$(date +%F).tar.gz \
  --exclude='staging' \
  --exclude='*.m4b' --exclude='*.mp3' --exclude='*.m4a' \
  --exclude='*.flac' --exclude='*.ogg' --exclude='*.opus' \
  --exclude='*.bak' \
  config data

docker compose start 4read-abs
```

Якщо бекапите всю машину з бібліотекою ABS і хочете **не** тягнути аудіо в цей же архів:

```bash
tar -czf abs-meta-only-$(date +%F).tar.gz \
  --exclude='*.m4b' --exclude='*.mp3' --exclude='*.m4a' \
  --exclude='*.flac' --exclude='*.ogg' --exclude='*.opus' \
  --exclude='staging' \
  /path/to/audiobooks /path/to/4read-abs/data /path/to/4read-abs/config
```

Так залишаються `metadata.json`, обкладинки й структура тек; важкі файли відновлюєте з окремого медіа-бекапу або з вашого джерела файлів.

### Відновлення

1. Зупиніть сервіс.
2. Розпакуйте `config/` і `data/` на колишні місця (або вкажіть `DATA_DIR` / `CONFIG_FILE`).
3. Переконайтеся, що `ABS_*` і `FLARESOLVERR_URL` знову в оточенні.
4. Запустіть сервіс і за потреби виконайте `4read-abs sync` — sidecar і обкладинки в бібліотеці/staging відновляться з каталогу в БД.

Cookie Cloudflare лежать у тій же БД; якщо застаріли, FlareSolverr отримає нові автоматично.

## CLI

Зручно для cron замість вбудованого планувальника:

```
4read-abs serve           Веб-UI і планувальник (за замовчуванням)
4read-abs seed            Індекси авторів і дикторів
4read-abs sitemap         Звірка каталогу з sitemap
4read-abs backfill [n]    До n сторінок деталей у черзі
4read-abs subscriptions   Перерахунок підписок і черги новинок
4read-abs sync            Запис sidecar у бібліотеку
4read-abs once            sitemap → subscriptions → sync
```

## Обмеження обсягу

Лише метадані, **без** завантаження аудіо. У `robots.txt` заборонені `/m3u/`, `/bed/` і
`do=download`; статті й лістинги дозволені. Підписки дають метадані й сповіщення —
медіафайли додаєте ви самі.

## Hardcover (опційно)

`HARDCOVER_API_KEY` — канонічні id Hardcover, ISBN/ASIN за впевненістю. Кеш постійний,
ліміти вільні. Покриття українських видань нерівномірне: збагачення лише додає поля,
джерело істини — ідентифікатори 4read; помилки мовчазні.

## Розробка

```bash
bun install
bun test          # офлайн-тести, без мережі
bun run typecheck
bun run dev
bun run build     # dist/4read-abs (linux-amd64)
```

Парсери перевіряються на реальних збережених сторінках у `test/fixtures/`; e2e — проти
мок 4read.org і мок Audiobookshelf.
