import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeForSearch(value: unknown): string {
    return String(value ?? "")
        .toLocaleLowerCase("tr-TR")
        .replace(/[^a-z0-9çğıöşü]+/gi, " ")
        .replace(/[\s\u00A0]+/g, " ")
        .trim();
}

function splitScopeSegments(value: unknown): string[] {
    return String(value ?? "")
        .split(/[;\n]+/)
        .map((item) => normalizeForSearch(item))
        .filter((item) => item.length >= 3);
}

function isPartialScopeSupported(
    fullText: unknown,
    partialText: unknown,
): boolean {

    const full =
        normalizeForSearch(fullText);

    const partial =
        normalizeForSearch(partialText);

    if (!full || !partial) {
        return false;
    }

    if (full === partial) {
        return false;
    }

    if (full.includes(partial)) {
        return true;
    }

    const segments =
        splitScopeSegments(partialText);

    return (
        segments.length > 0 &&
        segments.every(
            (segment) =>
                full.includes(segment)
        )
    );
}

function asStringArray(value: unknown): string[] {

    if (!Array.isArray(value)) {
        return [];
    }

    return [
        ...new Set(
            value
                .map(
                    (item) =>
                        String(item ?? "").trim()
                )
                .filter(Boolean)
        )
    ];
}

function parseHolderNames(value: unknown): string[] {

    if (!value) {
        return [];
    }

    if (typeof value === "string") {

        const trimmed =
            value.trim();

        if (!trimmed) {
            return [];
        }

        try {

            return parseHolderNames(
                JSON.parse(trimmed)
            );

        } catch {

            return [trimmed];
        }
    }

    if (Array.isArray(value)) {

        return [
            ...new Set(
                value
                    .flatMap((item) => {

                        if (typeof item === "string") {
                            return [item.trim()];
                        }

                        if (
                            !item ||
                            typeof item !== "object"
                        ) {
                            return [];
                        }

                        const candidate =
                            item.name ??
                            item.holderName ??
                            item.title ??
                            item.ownerName ??
                            item.applicantName ??
                            null;

                        return candidate
                            ? [String(candidate).trim()]
                            : [];
                    })
                    .filter(Boolean)
            )
        ];
    }

    if (typeof value === "object") {

        const obj =
            value as Record<string, any>;

        const candidate =
            obj.name ??
            obj.holderName ??
            obj.title ??
            obj.ownerName ??
            obj.applicantName ??
            null;

        return candidate
            ? [String(candidate).trim()]
            : [];
    }

    return [];
}

async function assertInternalUser(
    req: Request,
    supabase: ReturnType<typeof createClient>,
) {

    const authHeader =
        req.headers.get("Authorization") ?? "";

    const token =
        authHeader
            .replace(/^Bearer\s+/i, "")
            .trim();

    if (!token) {

        throw new HttpError(
            401,
            "Oturum bilgisi bulunamadı.",
        );
    }

    const {
        data: authData,
        error: authError,
    } =
        await supabase.auth.getUser(token);

    if (
        authError ||
        !authData.user
    ) {

        throw new HttpError(
            401,
            "Geçersiz veya süresi dolmuş oturum.",
        );
    }

    const {
        data: profile,
        error: profileError,
    } =
        await supabase
            .from("users")
            .select("id, role, disabled")
            .eq(
                "id",
                authData.user.id,
            )
            .maybeSingle();

    if (
        profileError ||
        !profile
    ) {

        throw new HttpError(
            403,
            "IP GATE kullanıcı profili bulunamadı.",
        );
    }

    if (profile.disabled) {

        throw new HttpError(
            403,
            "Kullanıcı hesabı pasif.",
        );
    }

    if (
        ![
            "user",
            "admin",
            "superadmin",
        ].includes(
            String(profile.role ?? "")
        )
    ) {

        throw new HttpError(
            403,
            "Bu dilekçe çalışma alanına erişim yetkiniz bulunmuyor.",
        );
    }

    return {
        id:
            authData.user.id,

        token,
    };
}

async function callFunction(
    supabaseUrl: string,
    functionName: string,
    token: string,
    body: any,
) {

    const response =
        await fetch(
            `${supabaseUrl}/functions/v1/${functionName}`,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${token}`,
                },

                body:
                    JSON.stringify(body),
            },
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new HttpError(
            response.status,

            data?.error ||
            `${functionName} çağrısı başarısız oldu.`,
        );
    }

    if (data?.success === false) {

        throw new HttpError(
            422,

            data.error ||
            `${functionName} işlemi başarısız oldu.`,
        );
    }

    return data;
}

async function loadAnalysisContext(
    supabaseUrl: string,
    token: string,
    taskId: string,
) {

    const data =
        await callFunction(
            supabaseUrl,
            "opposition-analysis",
            token,
            {
                action:
                    "get",

                taskId,
            },
        );

    if (!data?.context) {

        throw new HttpError(
            422,
            "SMK 6/1 analiz bağlamı alınamadı.",
        );
    }

    return data.context;
}

async function loadCaseMeta(
    supabase: ReturnType<typeof createClient>,
    taskId: string,
) {

    const {
        data: oppositionCase,
        error: caseError,
    } =
        await supabase
            .from("opposition_cases")
            .select(`
                id,
                task_id,
                client_id,
                opposed_ip_record_id,
                bulletin_record_id,
                selected_grounds,
                status,
                draft_version,
                current_draft,
                ai_analysis
            `)
            .eq(
                "task_id",
                taskId,
            )
            .maybeSingle();

    if (caseError) {

        throw new Error(
            `Opposition Case okunamadı: ${caseError.message}`,
        );
    }

    if (!oppositionCase) {

        throw new HttpError(
            422,
            "Opposition Case bulunamadı.",
        );
    }

    let clientName =
        "";

    if (oppositionCase.client_id) {

        const {
            data: client,
            error: clientError,
        } =
            await supabase
                .from("persons")
                .select("name")
                .eq(
                    "id",
                    oppositionCase.client_id,
                )
                .maybeSingle();

        if (clientError) {

            throw new Error(
                `Müvekkil bilgisi okunamadı: ${clientError.message}`,
            );
        }

        clientName =
            client?.name ?? "";
    }

    let opponentName =
        "Karşı Taraf";

    let bulletinNo:
        string | null =
        null;

    let bulletinDate:
        string | null =
        null;

    let opponentImageUrl:
        string | null =
        null;

    if (oppositionCase.bulletin_record_id) {

        const {
            data: bulletinRecord,
            error: bulletinRecordError,
        } =
            await supabase
                .from(
                    "trademark_bulletin_records"
                )
                .select(
                    "bulletin_id, holders, image_url"
                )
                .eq(
                    "id",
                    oppositionCase.bulletin_record_id,
                )
                .maybeSingle();

        if (bulletinRecordError) {

            throw new Error(
                `Rakip bülten kaydı okunamadı: ${bulletinRecordError.message}`,
            );
        }

        const holderNames =
            parseHolderNames(
                bulletinRecord?.holders
            );

        if (holderNames.length > 0) {

            opponentName =
                holderNames.join(", ");
        }

        opponentImageUrl =
            normalizeText(
                bulletinRecord?.image_url
            ) ||
            null;

        if (bulletinRecord?.bulletin_id) {

            const {
                data: bulletin,
                error: bulletinError,
            } =
                await supabase
                    .from(
                        "trademark_bulletins"
                    )
                    .select(
                        "bulletin_no, bulletin_date"
                    )
                    .eq(
                        "id",
                        bulletinRecord.bulletin_id,
                    )
                    .maybeSingle();

            if (bulletinError) {

                throw new Error(
                    `Bülten bilgisi okunamadı: ${bulletinError.message}`,
                );
            }

            bulletinNo =
                bulletin?.bulletin_no
                    ? String(
                        bulletin.bulletin_no
                    )
                    : null;

            bulletinDate =
                bulletin?.bulletin_date ??
                null;
        }
    }

    if (
        !opponentImageUrl &&
        oppositionCase.opposed_ip_record_id
    ) {

        const {
            data: opponentDetails,
            error: opponentDetailsError,
        } =
            await supabase
                .from(
                    "ip_record_trademark_details"
                )
                .select(
                    "brand_image_url"
                )
                .eq(
                    "ip_record_id",
                    oppositionCase.opposed_ip_record_id,
                )
                .maybeSingle();

        if (opponentDetailsError) {

            throw new Error(
                `Rakip marka görseli okunamadı: ${opponentDetailsError.message}`,
            );
        }

        opponentImageUrl =
            normalizeText(
                opponentDetails?.brand_image_url
            ) ||
            null;
    }

    return {
        oppositionCase,
        clientName,
        opponentName,
        bulletinNo,
        bulletinDate,
        opponentImageUrl,
    };
}

function buildCanonicalPayload(
    analysis: any,
    caseMeta: any,
) {

    const blockers:
        string[] =
        [];

    const warnings:
        string[] =
        [];

    const selectedGrounds =
        Array.isArray(
            analysis?.case?.selectedGrounds
        )
            ? analysis.case.selectedGrounds.map(String)
            : [];

    if (
        !selectedGrounds.includes(
            "SMK_6_1"
        )
    ) {

        blockers.push(
            "SMK 6/1 dosyada seçili değil.",
        );
    }

    const unsupportedGrounds =
        selectedGrounds.filter(
            (ground: string) =>
                ground !== "SMK_6_1"
        );

    if (
        unsupportedGrounds.length > 0
    ) {

        blockers.push(
            `Bu sürüm yalnız tamamlanmış SMK 6/1 analizinden dilekçe üretir. Şu gerekçeler için ayrıca decision tree gerekir: ${unsupportedGrounds.join(", ")}`,
        );
    }

    if (analysis?.stale) {

        blockers.push(
            "SMK 6/1 analizi güncel dosya verileriyle eşleşmiyor.",
        );
    }

    if (
        !analysis
            ?.readiness
            ?.canDraft
    ) {

        blockers.push(
            "SMK 6/1 decision tree dilekçe üretimine hazır değil.",
        );
    }

    if (!caseMeta.clientName) {

        blockers.push(
            "Müvekkil adı/unvanı bulunamadı.",
        );
    }

    const priorRights =
        Array.isArray(
            analysis?.priorRights
        )
            ? analysis.priorRights
            : [];

    const opponent =
        analysis?.opponent ?? {};

    const formData =
        analysis?.formData ?? {};

    if (
        priorRights.length === 0
    ) {

        blockers.push(
            "Seçili müstenit marka bulunamadı.",
        );
    }

    if (!opponent.markText) {

        blockers.push(
            "İtiraz edilen marka adı bulunamadı.",
        );
    }

    if (!opponent.applicationNo) {

        blockers.push(
            "İtiraz edilen başvuru numarası bulunamadı.",
        );
    }

    const goodsAssessments =
        Array.isArray(
            formData.goodsAssessments
        )
            ? formData.goodsAssessments
            : [];

    const requestedRows =
        goodsAssessments.filter(
            (row: any) =>
                row.requestedRefusal === true
        );

    if (
        requestedRows.length === 0
    ) {

        blockers.push(
            "Ret talep edilen rakip sınıf bulunmuyor.",
        );
    }

    const selectedRefusalClasses =
        [
            ...new Set(
                requestedRows
                    .map(
                        (row: any) =>
                            Number(
                                row.opponentClassNo
                            )
                    )
                    .filter(
                        (n: number) =>
                            Number.isFinite(n)
                    )
            )
        ].sort(
            (a, b) =>
                a - b
        );

    const matchedByPrior =
        new Map<
            string,
            Set<number>
        >();

    for (
        const row of
        requestedRows
    ) {

        if (
            [
                "none",
                "not_assessed",
                "",
            ].includes(
                String(
                    row.similarityLevel ??
                    ""
                )
            )
        ) {

            blockers.push(
                `Rakip Sınıf ${row.opponentClassNo} için ret talebi ile benzerlik sonucu uyumsuz.`,
            );
        }

        if (
            !Array.isArray(
                row.matchedPriorClasses
            ) ||
            row.matchedPriorClasses.length === 0
        ) {

            blockers.push(
                `Rakip Sınıf ${row.opponentClassNo} için dayanılan müstenit sınıf bulunmuyor.`,
            );
        }

        if (
            !Array.isArray(
                row.criteria
            ) ||
            row.criteria.length === 0
        ) {

            blockers.push(
                `Rakip Sınıf ${row.opponentClassNo} için emtia benzerliği kriteri bulunmuyor.`,
            );
        }

        for (
            const key of
            asStringArray(
                row.matchedPriorClasses
            )
        ) {

            const splitIndex =
                key.lastIndexOf(":");

            if (
                splitIndex <= 0
            ) {
                continue;
            }

            const priorId =
                key.slice(
                    0,
                    splitIndex
                );

            const classNo =
                Number(
                    key.slice(
                        splitIndex + 1
                    )
                );

            if (
                !priorId ||
                !Number.isFinite(
                    classNo
                )
            ) {
                continue;
            }

            if (
                !matchedByPrior.has(
                    priorId
                )
            ) {

                matchedByPrior.set(
                    priorId,
                    new Set<number>(),
                );
            }

            matchedByPrior
                .get(priorId)!
                .add(classNo);
        }
    }

    const clientMarks =
        priorRights.map(
            (right: any) => {

                const matchedClasses =
                    matchedByPrior.get(
                        String(right.id)
                    ) ??
                    new Set<number>();

                const selectedClasses =
                    (
                        right.classes ??
                        []
                    )
                        .filter(
                            (cls: any) =>
                                matchedClasses.has(
                                    Number(
                                        cls.classNo
                                    )
                                )
                        )
                        .map(
                            (cls: any) => ({
                                classNo:
                                    Number(
                                        cls.classNo
                                    ),

                                items:
                                    Array.isArray(
                                        cls.items
                                    )
                                        ? cls.items.map(String)
                                        : [],
                            })
                        );

                return {
                    ipRecordId:
                        right.id,

                    markText:
                        right.markText,

                    markType:
                        right.markType,

                    imageUrl:
                        right.imageUrl ??
                        null,

                    applicationNo:
                        right.applicationNo,

                    applicationDate:
                        right.applicationDate,

                    registrationNo:
                        right.registrationNo,

                    registrationDate:
                        right.registrationDate,

                    proofOfUseRequired:
                        right.proofOfUseRequired,

                    proofOfUseStatus:
                        right.proofOfUseStatus,

                    classes:
                        selectedClasses,

                    goodsServices:
                        selectedClasses
                            .flatMap(
                                (cls: any) =>
                                    cls.items
                            ),
                };
            }
        );

    if (
        !clientMarks.some(
            (mark: any) =>
                mark.goodsServices.length > 0
        )
    ) {

        blockers.push(
            "Dayanılan müstenit sınıfların gerçek mal/hizmet metni bulunmuyor.",
        );
    }

    const opponentGoodsByClass =
        Array.isArray(
            opponent.goodsByClass
        )
            ? opponent.goodsByClass
            : [];

    const requestedRefusalScopes =
        requestedRows.map(
            (row: any) => {

                const classNo =
                    Number(
                        row.opponentClassNo
                    );

                const canonicalRow =
                    opponentGoodsByClass.find(
                        (goods: any) =>
                            Number(
                                goods.classNo
                            ) === classNo
                    );

                const fullClassText =
                    normalizeText(
                        canonicalRow?.text
                    );

                if (!fullClassText) {

                    blockers.push(
                        `Rakip Sınıf ${classNo} için canonical mal/hizmet metni bulunamadı.`,
                    );
                }

                const mode =
                    normalizeText(
                        row.refusalScopeMode
                    );

                let exactText =
                    "";

                if (
                    mode ===
                    "full_class"
                ) {

                    exactText =
                        fullClassText;

                } else if (
                    mode ===
                    "partial"
                ) {

                    exactText =
                        normalizeText(
                            row.refusalScopeText
                        );

                    if (!exactText) {

                        blockers.push(
                            `Rakip Sınıf ${classNo} için kısmi ret kapsamı boş.`,
                        );

                    } else if (
                        !isPartialScopeSupported(
                            fullClassText,
                            exactText,
                        )
                    ) {

                        blockers.push(
                            `Rakip Sınıf ${classNo} için kısmi ret kapsamı canonical rakip kapsamıyla eşleşmiyor.`,
                        );
                    }

                } else {

                    blockers.push(
                        `Rakip Sınıf ${classNo} için ret kapsamı modu seçilmedi.`,
                    );
                }

                return {
                    classNo,
                    mode,
                    text:
                        exactText,
                    fullClassText,
                };
            }
        );

    const requestedOpponentGoods =
        requestedRefusalScopes
            .filter(
                (row: any) =>
                    Boolean(row.text)
            )
            .map(
                (row: any) => ({
                    classNo:
                        row.classNo,

                    scopeMode:
                        row.mode,

                    text:
                        row.text,

                    fullClassText:
                        row.fullClassText,
                })
            );

    if (
        requestedOpponentGoods.length === 0
    ) {

        blockers.push(
            "Ret kapsamındaki gerçek rakip mal/hizmet metni bulunmuyor.",
        );
    }

    const payload = {

        oppositionCaseId:
            analysis?.case?.id,

        taskId:
            analysis?.task?.id,

        sourceFingerprint:
            analysis?.sourceFingerprint,

        clientName:
            caseMeta.clientName,

        clientMarks,

        opponentName:
            caseMeta.opponentName,

        opponentApplication: {

            markText:
                opponent.markText,

            applicationNo:
                opponent.applicationNo,

            applicationDate:
                opponent.applicationDate,

            niceClasses:
                asStringArray(
                    opponent.niceClasses
                ),

            requestedRefusalClasses:
                selectedRefusalClasses,

            requestedRefusalScopes:
                requestedRefusalScopes,

            goodsByClass:
                requestedOpponentGoods,

            goodsServices:
                requestedOpponentGoods
                    .map(
                        (row: any) =>
                            row.text
                    )
                    .filter(Boolean),
        },

        selectedGrounds: [
            "SMK_6_1",
        ],

        lawyerAssessment: {

            version:
                2,

            sourceFingerprint:
                analysis?.sourceFingerprint,

            priorRightsReview:
                formData.priorRightsReview ??
                [],

            goodsAssessments,

            signAssessment:
                formData.signAssessment ??
                {},

            publicAssessment:
                formData.publicAssessment ??
                {},

            globalAssessment:
                formData.globalAssessment ??
                {},

            readiness:
                analysis?.readiness ??
                {},
        },

        bulletinInfo: {

            bulletinNo:
                caseMeta.bulletinNo,

            bulletinDate:
                caseMeta.bulletinDate,
        },
    };

    return {

        canGenerate:
            blockers.length === 0,

        blockers:
            [...new Set(blockers)],

        warnings:
            [...new Set(warnings)],

        payload,

        selectedRefusalClasses,

        selectedRefusalScopes:
            requestedRefusalScopes,
    };
}



// =========================================================
// PAKET 5 - PROFESSIONAL DOCUMENT DATA
// =========================================================

const GOODS_CRITERIA_LABELS:
    Record<string, string> = {

    nature:
        "Nitelik / doğa",

    purpose:
        "Amaç",

    use_method:
        "Kullanım biçimi",

    complementary:
        "Tamamlayıcılık",

    competitive:
        "Rekabet / ikame",

    distribution_channels:
        "Dağıtım / sunum kanalları",

    relevant_public:
        "İlgili tüketici kesimi",
};


const GOODS_SIMILARITY_LABELS:
    Record<string, string> = {

    identical:
        "Aynı",

    high:
        "Yüksek",

    medium:
        "Orta",

    low:
        "Düşük",

    none:
        "Benzer değil",

    not_assessed:
        "Değerlendirilmedi",
};


function normalizedClassNumbers(
    value: unknown,
): number[] {

    if (!Array.isArray(value)) {
        return [];
    }

    return [
        ...new Set(
            value
                .map(
                    item =>
                        Number(item)
                )
                .filter(
                    item =>
                        Number.isFinite(item)
                )
        )
    ].sort(
        (a, b) =>
            a - b
    );
}


function buildProfessionalDocumentData(
    caseMeta: any,
    canonical: any,
) {

    const payload =
        canonical.payload ??
        {};

    const opponent =
        payload.opponentApplication ??
        {};

    const priorMarks =
        (
            payload.clientMarks ??
            []
        ).map(
            (mark: any) => ({

                ipRecordId:
                    mark.ipRecordId,

                markText:
                    mark.markText,

                markType:
                    mark.markType,

                imageUrl:
                    mark.imageUrl ??
                    null,

                applicationNo:
                    mark.applicationNo,

                applicationDate:
                    mark.applicationDate,

                registrationNo:
                    mark.registrationNo,

                registrationDate:
                    mark.registrationDate,

                proofOfUseRequired:
                    mark.proofOfUseRequired,

                proofOfUseStatus:
                    mark.proofOfUseStatus,

                classes:
                    (
                        mark.classes ??
                        []
                    ).map(
                        (cls: any) => ({
                            classNo:
                                Number(
                                    cls.classNo
                                ),

                            items:
                                Array.isArray(
                                    cls.items
                                )
                                    ? cls.items.map(String)
                                    : [],
                        })
                    ),
            })
        );


    const refusalScopes =
        (
            canonical.selectedRefusalScopes ??
            []
        ).map(
            (scope: any) => ({

                classNo:
                    Number(
                        scope.classNo
                    ),

                mode:
                    scope.mode,

                modeLabel:
                    scope.mode ===
                    "full_class"

                        ? "Sınıfın tamamı"

                        : "Kısmi kapsam",

                text:
                    normalizeText(
                        scope.text
                    ),

                fullClassText:
                    normalizeText(
                        scope.fullClassText
                    ),
            })
        );


    const opponentNiceClasses =
        normalizedClassNumbers(
            opponent.niceClasses
        );


    const refusalClassNumbers =
        normalizedClassNumbers(
            refusalScopes.map(
                (scope: any) =>
                    scope.classNo
            )
        );


    const isWholeApplicationRefusal =
        opponentNiceClasses.length > 0 &&
        opponentNiceClasses.length ===
        refusalClassNumbers.length &&
        opponentNiceClasses.every(
            classNo =>
                refusalClassNumbers.includes(
                    classNo
                )
        ) &&
        refusalScopes.every(
            (scope: any) =>
                scope.mode ===
                "full_class"
        );


    const goodsAssessments =
        Array.isArray(
            payload
                ?.lawyerAssessment
                ?.goodsAssessments
        )
            ? payload
                .lawyerAssessment
                .goodsAssessments
            : [];


    const goodsComparisons:
        any[] =
        [];


    for (
        const row of
        goodsAssessments
    ) {

        if (
            row.requestedRefusal !==
            true
        ) {

            continue;
        }


        const opponentClassNo =
            Number(
                row.opponentClassNo
            );


        const scope =
            refusalScopes.find(
                (item: any) =>
                    Number(
                        item.classNo
                    ) ===
                    opponentClassNo
            );


        for (
            const key of
            asStringArray(
                row.matchedPriorClasses
            )
        ) {

            const splitIndex =
                key.lastIndexOf(":");


            if (
                splitIndex <= 0
            ) {

                continue;
            }


            const priorId =
                key.slice(
                    0,
                    splitIndex
                );


            const priorClassNo =
                Number(
                    key.slice(
                        splitIndex + 1
                    )
                );


            const priorMark =
                priorMarks.find(
                    (mark: any) =>
                        String(
                            mark.ipRecordId
                        ) ===
                        String(
                            priorId
                        )
                );


            const priorClass =
                priorMark
                    ?.classes
                    ?.find(
                        (cls: any) =>
                            Number(
                                cls.classNo
                            ) ===
                            priorClassNo
                    );


            if (
                !priorMark ||
                !priorClass
            ) {

                continue;
            }


            goodsComparisons.push({

                opponentClassNo,

                opponentText:
                    scope?.text ??
                    normalizeText(
                        row.opponentText
                    ),

                priorIpRecordId:
                    priorMark.ipRecordId,

                priorMarkText:
                    priorMark.markText,

                priorApplicationNo:
                    priorMark.applicationNo,

                priorClassNo,

                priorText:
                    (
                        priorClass.items ??
                        []
                    ).join("; "),

                similarityLevel:
                    normalizeText(
                        row.similarityLevel
                    ),

                similarityLabel:
                    GOODS_SIMILARITY_LABELS[
                        normalizeText(
                            row.similarityLevel
                        )
                    ] ??
                    normalizeText(
                        row.similarityLevel
                    ),

                criteria:
                    asStringArray(
                        row.criteria
                    ),

                criteriaLabels:
                    asStringArray(
                        row.criteria
                    ).map(
                        criterion =>
                            GOODS_CRITERIA_LABELS[
                                criterion
                            ] ??
                            criterion
                    ),

                note:
                    normalizeText(
                        row.note
                    ),
            });
        }
    }


    const opponentApplicationNo =
        normalizeText(
            opponent.applicationNo
        );


    const opponentMarkText =
        normalizeText(
            opponent.markText
        );


    const topicText =
        refusalScopes.length ===
        1

            ? (
                refusalScopes[0].mode ===
                "full_class"

                    ? `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${refusalScopes[0].classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddi talebimizdir.`

                    : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${refusalScopes[0].classNo}. sınıfta aşağıda belirtilen mal ve hizmetler bakımından reddi talebimizdir.`
            )

            : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca aşağıda belirtilen sınıf ve kapsamlar bakımından reddi talebimizdir.`;


    const resultItems = [
        ...refusalScopes.map(
            (scope: any) =>

                scope.mode ===
                "full_class"

                    ? `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddine,`

                    : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan şu mal ve hizmetler bakımından reddine: ${scope.text}`,
        ),

        "İtirazımızın kabulüne karar verilmesini saygılarımızla arz ve talep ederiz.",
    ];


    const bulletinDateText =
        caseMeta.bulletinDate

            ? new Date(
                `${String(caseMeta.bulletinDate).slice(0, 10)}T00:00:00Z`
            )
                .toLocaleDateString(
                    "tr-TR",
                    {
                        timeZone:
                            "UTC",
                    },
                )

            : null;


    const bulletinText =
        caseMeta.bulletinNo &&
        bulletinDateText

            ? `${bulletinDateText} tarihli ve ${caseMeta.bulletinNo} sayılı`

            : caseMeta.bulletinNo

                ? `${caseMeta.bulletinNo} sayılı`

                : "İlgili Bülten";


    return {

        version:
            1,

        packageVersion:
            "5.1",

        sourceFingerprint:
            payload.sourceFingerprint,

        clientName:
            caseMeta.clientName ||
            "Müvekkil",

        representativeName:
            "Evreka Group Danışmanlık",

        bulletinNo:
            caseMeta.bulletinNo,

        bulletinDate:
            caseMeta.bulletinDate,

        bulletinText,

        topicText,

        wholeApplicationRefusal:
            isWholeApplicationRefusal,

        wordExportPolicy: {
            minimumQaVersion:
                3,

            requiredQaPackageVersion:
                "4.2",

            documentPackageVersion:
                "5.1",
        },

        opponent: {

            ownerName:
                caseMeta.opponentName ||
                "Karşı Taraf",

            markText:
                opponentMarkText,

            imageUrl:
                caseMeta.opponentImageUrl ??
                null,

            applicationNo:
                opponentApplicationNo,

            applicationDate:
                opponent.applicationDate,

            niceClasses:
                opponentNiceClasses,
        },

        priorMarks,

        refusalScopes,

        goodsComparisons,

        resultItems,

        documentDate:
            new Date()
                .toLocaleDateString(
                    "tr-TR",
                    {
                        timeZone:
                            "Europe/Istanbul",
                    },
                ),
    };
}


// =========================================================
// PAKET 4.1 - FILING SAFETY QA HELPERS
// =========================================================

function draftSentences(
    text: string,
): string[] {

    return String(
        text ?? ""
    )
        .split(
            /(?<=[.!?])\s+|\n+/
        )
        .map(
            (item) =>
                item.trim()
        )
        .filter(Boolean);
}

function detectSimilarityLevels(
    sentence: string,
): string[] {

    const levels =
        new Set<string>();

    if (
        /\byüksek(?:\s+(?:derecede|düzeyde))?\s+(?:bir\s+)?benzer/i
            .test(sentence) ||
        /\bgörsel\s+olarak\s+yüksek\b/i
            .test(sentence)
    ) {

        levels.add(
            "high"
        );
    }

    if (
        /\borta(?:\s+(?:derecede|düzeyde))?\s+(?:bir\s+)?benzer/i
            .test(sentence)
    ) {

        levels.add(
            "medium"
        );
    }

    if (
        /\bdüşük(?:\s+(?:derecede|düzeyde))?\s+(?:bir\s+)?benzer/i
            .test(sentence)
    ) {

        levels.add(
            "low"
        );
    }

    if (
        /\bbenzer\s+değil/i
            .test(sentence) ||
        /\bbenzerlik\s+(?:yok|yoktur|bulunmamaktadır|bulunmamakta)\b/i
            .test(sentence)
    ) {

        levels.add(
            "none"
        );
    }

    if (
        /\bkarşılaştırma\s+(?:yapılamaz|mümkün değildir)\b/i
            .test(sentence)
    ) {

        levels.add(
            "no_comparison"
        );
    }

    return [
        ...levels
    ];
}

function validateSimilarityLocks(
    draft: string,
    signAssessment: any,
): string[] {

    const blockers:
        string[] =
        [];

    const sentences =
        draftSentences(
            draft
        );

    const dimensions = [

        {
            label:
                "görsel",

            field:
                "visualSimilarity",

            matcher:
                /\bgörsel\b/i,
        },

        {
            label:
                "işitsel/fonetik",

            field:
                "auralSimilarity",

            matcher:
                /\bişitsel\b|\bfonetik\b/i,
        },

        {
            label:
                "kavramsal/anlamsal",

            field:
                "conceptualSimilarity",

            matcher:
                /\bkavramsal\b|\banlamsal\b/i,
        },

        {
            label:
                "genel izlenim",

            field:
                "overallSimilarity",

            matcher:
                /\bgenel izlenim\b/i,
        },
    ];

    for (
        const dimension of
        dimensions
    ) {

        const expected =
            normalizeText(
                signAssessment
                    ?.[dimension.field]
            );

        if (!expected) {
            continue;
        }

        for (
            const sentence of
            sentences
        ) {

            if (
                !dimension.matcher.test(
                    sentence
                )
            ) {
                continue;
            }

            const detected =
                detectSimilarityLevels(
                    sentence
                );

            for (
                const level of
                detected
            ) {

                if (
                    level !==
                    expected
                ) {

                    blockers.push(
                        `${dimension.label} benzerlik derecesi avukat bulgusuyla çelişiyor. Beklenen: ${expected}. Taslak cümlesi: ${sentence}`,
                    );
                }
            }
        }
    }

    return blockers;
}

function splitElementNames(
    value: unknown,
): string[] {

    return String(
        value ?? ""
    )
        .split(
            /[,/;\n]+/
        )
        .map(
            (item) =>
                normalizeForSearch(item)
        )
        .filter(
            (item) =>
                item &&
                item !== "yok"
        );
}

function clausesForElement(
    sentence: string,
    element: string,
): string[] {

    const clauses =
        String(
            sentence ?? ""
        )
            .split(
                /[,;:]|\bancak\b|\bise\b/gi
            )
            .map(
                (item) =>
                    item.trim()
            )
            .filter(Boolean);

    const matched =
        clauses.filter(
            (clause) =>
                normalizeForSearch(
                    clause
                ).includes(
                    element
                )
        );

    if (
        matched.length > 0
    ) {

        return matched;
    }

    const normalizedSentence =
        normalizeForSearch(
            sentence
        );

    const index =
        normalizedSentence.indexOf(
            element
        );

    if (
        index < 0
    ) {

        return [];
    }

    const start =
        Math.max(
            0,
            index - 120
        );

    const end =
        Math.min(
            normalizedSentence.length,
            index +
            element.length +
            160
        );

    return [
        normalizedSentence.slice(
            start,
            end
        )
    ];
}

function detectDistinctivenessLevels(
    text: string,
): string[] {

    const result =
        new Set<string>();

    if (
        /\byüksek\s+ayırt\s+edic/i
            .test(text)
    ) {

        result.add(
            "high"
        );
    }

    if (
        /\bnormal\s+ayırt\s+edic/i
            .test(text)
    ) {

        result.add(
            "normal"
        );
    }

    if (
        /\bzayıf\s+ayırt\s+edic/i
            .test(text) ||
        /\bayırt\s+ediciliği\s+zayıf\b/i
            .test(text)
    ) {

        result.add(
            "weak"
        );
    }

    if (
        /\btanımlayıcı\b/i
            .test(text) ||
        /\btasviri\b/i
            .test(text)
    ) {

        result.add(
            "descriptive"
        );
    }

    if (
        /\bayırt\s+edici\s+değil/i
            .test(text) ||
        /\bayırt\s+edici\s+olmayan/i
            .test(text) ||
        /\bayırt\s+edicilik\s+taşım/i
            .test(text)
    ) {

        result.add(
            "non_distinctive"
        );
    }

    return [
        ...result
    ];
}

function detectElementRoles(
    text: string,
): string[] {

    const result =
        new Set<string>();

    if (
        /\btali\b/i
            .test(text) ||
        /\bihmal\s+edilebilir\b/i
            .test(text)
    ) {

        result.add(
            "negligible"
        );
    }

    if (
        /\bikincil(?:\s+fakat)?\s+ayırt\s+edici\b/i
            .test(text)
    ) {

        result.add(
            "secondary_distinctive"
        );
    }

    if (
        /\bbirlikte\s+baskın\b/i
            .test(text) ||
        /\beş\s*baskın\b/i
            .test(text)
    ) {

        result.add(
            "co_dominant"
        );
    }

    if (
        /\bbaskın\s+unsur\b/i
            .test(text) ||
        /\basli\s+unsur\b/i
            .test(text) ||
        /\baslı\s+unsur\b/i
            .test(text) ||
        /\besas\s+unsur\b/i
            .test(text)
    ) {

        result.add(
            "dominant"
        );
    }

    return [
        ...result
    ];
}

function validateOneElementLock(
    draft: string,
    sideLabel: string,
    elementsValue: unknown,
    expectedDistinctiveness: unknown,
    expectedRole: unknown,
): string[] {

    const blockers:
        string[] =
        [];

    const elements =
        splitElementNames(
            elementsValue
        );

    if (
        !elements.length
    ) {

        return blockers;
    }

    const sentences =
        draftSentences(
            draft
        );

    for (
        const element of
        elements
    ) {

        for (
            const sentence of
            sentences
        ) {

            if (
                !normalizeForSearch(
                    sentence
                ).includes(
                    element
                )
            ) {

                continue;
            }

            const relevantClauses =
                clausesForElement(
                    sentence,
                    element,
                );

            for (
                const clause of
                relevantClauses
            ) {

                const detectedDistinctiveness =
                    detectDistinctivenessLevels(
                        clause
                    );

                const expectedDist =
                    normalizeText(
                        expectedDistinctiveness
                    );

                if (
                    [
                        "not_assessed",
                        "not_applicable",
                    ].includes(
                        expectedDist
                    ) &&
                    detectedDistinctiveness.length > 0
                ) {

                    blockers.push(
                        `${sideLabel} ek unsuru "${element}" hakkında avukat ayırt edicilik tespiti yapmamışken taslak hukuki nitelendirme üretiyor: ${clause}`,
                    );

                } else if (
                    expectedDist &&
                    ![
                        "not_assessed",
                        "not_applicable",
                    ].includes(
                        expectedDist
                    )
                ) {

                    for (
                        const detected of
                        detectedDistinctiveness
                    ) {

                        if (
                            detected !==
                            expectedDist
                        ) {

                            blockers.push(
                                `${sideLabel} ek unsuru "${element}" için ayırt edicilik nitelendirmesi avukat bulgusuyla çelişiyor. Beklenen: ${expectedDist}. Taslak: ${clause}`,
                            );
                        }
                    }
                }

                const detectedRoles =
                    detectElementRoles(
                        clause
                    );

                const expectedRoleValue =
                    normalizeText(
                        expectedRole
                    );

                if (
                    [
                        "not_assessed",
                        "not_applicable",
                    ].includes(
                        expectedRoleValue
                    ) &&
                    detectedRoles.length > 0
                ) {

                    blockers.push(
                        `${sideLabel} ek unsuru "${element}" hakkında avukat rol tespiti yapmamışken taslak rol nitelendirmesi üretiyor: ${clause}`,
                    );

                } else if (
                    expectedRoleValue &&
                    ![
                        "not_assessed",
                        "not_applicable",
                    ].includes(
                        expectedRoleValue
                    )
                ) {

                    for (
                        const detected of
                        detectedRoles
                    ) {

                        if (
                            detected !==
                            expectedRoleValue
                        ) {

                            blockers.push(
                                `${sideLabel} ek unsuru "${element}" için rol nitelendirmesi avukat bulgusuyla çelişiyor. Beklenen: ${expectedRoleValue}. Taslak: ${clause}`,
                            );
                        }
                    }
                }
            }
        }
    }

    return blockers;
}

function validateElementQualificationLocks(
    draft: string,
    signAssessment: any,
): string[] {

    return [

        ...validateOneElementLock(
            draft,

            "Müstenit marka",

            signAssessment
                ?.clientAdditionalElements,

            signAssessment
                ?.clientAdditionalDistinctiveness,

            signAssessment
                ?.clientAdditionalRole,
        ),

        ...validateOneElementLock(
            draft,

            "Rakip marka",

            signAssessment
                ?.opponentAdditionalElements,

            signAssessment
                ?.opponentAdditionalDistinctiveness,

            signAssessment
                ?.opponentAdditionalRole,
        ),
    ];
}

function extractMentionedClassNumbers(
    draft: string,
): number[] {

    const found =
        new Set<number>();

    const regex =
        /\b(\d{1,2})\.?\s*sınıf\b|\bsınıf\s*(\d{1,2})\b/gi;

    let match;

    while (
        (
            match =
                regex.exec(draft)
        ) !== null
    ) {

        const classNo =
            Number(
                match[1] ||
                match[2]
            );

        if (
            Number.isFinite(
                classNo
            )
        ) {

            found.add(
                classNo
            );
        }
    }

    return [
        ...found
    ];
}

function allowedDraftClassNumbers(
    payload: any,
): Set<number> {

    const allowed =
        new Set<number>();

    for (
        const scope of
        payload
            ?.opponentApplication
            ?.requestedRefusalScopes ??
        []
    ) {

        const classNo =
            Number(
                scope.classNo
            );

        if (
            Number.isFinite(
                classNo
            )
        ) {

            allowed.add(
                classNo
            );
        }
    }

    for (
        const row of
        payload
            ?.lawyerAssessment
            ?.goodsAssessments ??
        []
    ) {

        if (
            row.requestedRefusal !==
            true
        ) {

            continue;
        }

        for (
            const key of
            asStringArray(
                row.matchedPriorClasses
            )
        ) {

            const splitIndex =
                key.lastIndexOf(":");

            if (
                splitIndex <= 0
            ) {

                continue;
            }

            const classNo =
                Number(
                    key.slice(
                        splitIndex + 1
                    )
                );

            if (
                Number.isFinite(
                    classNo
                )
            ) {

                allowed.add(
                    classNo
                );
            }
        }
    }

    return allowed;
}

function validatePartialRefusalOverreach(
    draft: string,
    payload: any,
): string[] {

    const blockers:
        string[] =
        [];

    const partialScopes =
        (
            payload
                ?.opponentApplication
                ?.requestedRefusalScopes ??
            []
        ).filter(
            (scope: any) =>
                scope.mode ===
                "partial"
        );

    if (
        partialScopes.length === 0
    ) {

        return blockers;
    }

    if (
        /\bbaşvurunun\s+tam(?:amının)?\s+redd/i
            .test(draft) ||
        /\bbaşvurunun\s+tam\s+reddi\b/i
            .test(draft)
    ) {

        blockers.push(
            "Dosyada kısmi ret kapsamı bulunmasına rağmen taslak başvurunun tamamının/tam reddinin istendiğini söylüyor.",
        );
    }

    for (
        const scope of
        partialScopes
    ) {

        const classNo =
            Number(
                scope.classNo
            );

        if (
            !Number.isFinite(
                classNo
            )
        ) {

            continue;
        }

        const patterns = [

            new RegExp(
                `\\b${classNo}\\.?\\s*sınıf(?:ın)?\\s+tamam`,
                "i",
            ),

            new RegExp(
                `\\bsınıf\\s*${classNo}(?:'in|’in|ın|in)?\\s+tamam`,
                "i",
            ),

            new RegExp(
                `\\b${classNo}\\.?\\s*sınıf(?:\\s+yönünden)?\\s+tam\\s+ret`,
                "i",
            ),
        ];

        if (
            patterns.some(
                (pattern) =>
                    pattern.test(draft)
            )
        ) {

            blockers.push(
                `Rakip Sınıf ${classNo} için kısmi ret seçilmiş olmasına rağmen taslak sınıfın tamamının/tam reddin istendiğini söylüyor.`,
            );
        }
    }

    return blockers;
}

function deterministicDraftQa(
    draft: string,
    payload: any,
) {

    const blockers:
        string[] =
        [];

    const warnings:
        string[] =
        [];

    const text =
        normalizeText(
            draft
        );

    const normalizedDraft =
        normalizeForSearch(
            text
        );


    // ==========================================
    // 1. INTERNAL RAG ID LEAK
    // ==========================================

    const internalSourceIds =
        [
            ...new Set(
                text.match(
                    /\bK\d{1,3}\b/g
                ) ??
                []
            )
        ];

    if (
        internalSourceIds.length > 0
    ) {

        blockers.push(
            `Taslakta iç RAG kaynak kodları bulundu: ${internalSourceIds.join(", ")}. K kodları filing metnine giremez.`,
        );
    }


    // ==========================================
    // 2. SIGN ASSESSMENT LOCK
    // ==========================================

    blockers.push(
        ...validateSimilarityLocks(
            text,

            payload
                ?.lawyerAssessment
                ?.signAssessment ??
            {},
        )
    );


    // ==========================================
    // 3. ELEMENT QUALIFICATION LOCK
    // ==========================================

    blockers.push(
        ...validateElementQualificationLocks(
            text,

            payload
                ?.lawyerAssessment
                ?.signAssessment ??
            {},
        )
    );


    // ==========================================
    // 4. MATCHED CLASS LOCK
    // ==========================================

    const allowedClasses =
        allowedDraftClassNumbers(
            payload
        );

    const mentionedClasses =
        extractMentionedClassNumbers(
            text
        );

    for (
        const classNo of
        mentionedClasses
    ) {

        if (
            !allowedClasses.has(
                classNo
            )
        ) {

            blockers.push(
                `Taslakta avukatın emtia eşleştirmesinde bulunmayan Sınıf ${classNo} kullanılmış.`,
            );
        }
    }


    // ==========================================
    // 5. PARTIAL REFUSAL OVERREACH
    // ==========================================

    blockers.push(
        ...validatePartialRefusalOverreach(
            text,
            payload,
        )
    );


    // ==========================================
    // 6. CONTROLLED VOCABULARY
    // ==========================================

    if (
        /\bçekirdek\s+unsur\b/i
            .test(text)
    ) {

        blockers.push(
            'Taslakta kontrol dışı "çekirdek unsur" nitelendirmesi kullanılmış.',
        );
    }


    // ==========================================
    // 7. BASIC DRAFT SANITY
    // ==========================================

    if (
        text.length < 500
    ) {

        blockers.push(
            "Taslak olağan dışı derecede kısa.",
        );
    }

    const opponentMark =
        normalizeForSearch(
            payload
                .opponentApplication
                ?.markText
        );

    if (
        opponentMark &&
        !normalizedDraft.includes(
            opponentMark
        )
    ) {

        blockers.push(
            "Taslakta itiraz edilen marka adı bulunmuyor.",
        );
    }

    const priorMarks =
        (
            payload.clientMarks ??
            []
        )
            .map(
                (mark: any) =>
                    normalizeForSearch(
                        mark.markText
                    )
            )
            .filter(Boolean);

    if (
        priorMarks.length > 0 &&
        !priorMarks.some(
            (mark: string) =>
                normalizedDraft.includes(
                    mark
                )
        )
    ) {

        blockers.push(
            "Taslakta seçili müstenit markalardan hiçbiri anılmıyor.",
        );
    }


    // ==========================================
    // 8. FORBIDDEN 6/1-ONLY CLAIMS
    // ==========================================

    const forbiddenPatterns = [

        {
            regex:
                /\bkötü\s+niyet\b/i,

            label:
                "kötü niyet",
        },

        {
            regex:
                /\bSMK\s*6\s*\/\s*9\b/i,

            label:
                "SMK 6/9",
        },

        {
            regex:
                /\bSMK\s*6\s*\/\s*5\b/i,

            label:
                "SMK 6/5",
        },

        {
            regex:
                /\btanınmış(?:lık)?\b/i,

            label:
                "tanınmışlık",
        },

        {
            regex:
                /\bseri\s+marka\b/i,

            label:
                "seri marka",
        },

        {
            regex:
                /\bmarka\s+ailesi\b/i,

            label:
                "marka ailesi",
        },
    ];

    for (
        const item of
        forbiddenPatterns
    ) {

        if (
            item.regex.test(
                text
            )
        ) {

            blockers.push(
                `Taslakta bu 6/1-only dosyada desteklenmeyen ifade bulundu: ${item.label}.`,
            );
        }
    }


    // ==========================================
    // 9. APPLICATION NUMBER LOCK
    // ==========================================

    const allowedApplicationNumbers =
        new Set<string>();

    const opponentAppNo =
        normalizeText(
            payload
                .opponentApplication
                ?.applicationNo
        );

    if (opponentAppNo) {

        allowedApplicationNumbers.add(
            opponentAppNo
        );
    }

    for (
        const mark of
        payload.clientMarks ??
        []
    ) {

        const appNo =
            normalizeText(
                mark.applicationNo
            );

        if (appNo) {

            allowedApplicationNumbers.add(
                appNo
            );
        }
    }

    const foundApplicationNumbers =
        text.match(
            /\b20\d{2}[\/-]\d{3,}\b/g
        ) ??
        [];

    for (
        const found of
        [...new Set(
            foundApplicationNumbers
        )]
    ) {

        if (
            !allowedApplicationNumbers.has(
                found
            )
        ) {

            blockers.push(
                `Taslakta dosya verilerinde olmayan başvuru numarası bulundu: ${found}`,
            );
        }
    }


    // ==========================================
    // 10. STRUCTURAL WARNINGS
    // ==========================================

    if (
        !text.startsWith(
            "AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER"
        )
    ) {

        warnings.push(
            "Taslak standart başlıkla başlamıyor.",
        );
    }

    if (
        /\bsonuç\s+ve\s+talep\b/i
            .test(text)
    ) {

        warnings.push(
            "Taslak gövdesinde ayrıca Sonuç ve Talep bölümü var; Word şablonu ile çakışma kontrol edilmeli.",
        );
    }

    return {

        pass:
            blockers.length === 0,

        blockers:
            [...new Set(blockers)],

        warnings:
            [...new Set(warnings)],

        checkedAt:
            new Date().toISOString(),
    };
}

async function loadDraftHistory(
    supabase: ReturnType<typeof createClient>,
    oppositionCaseId: string,
) {

    const {
        data,
        error,
    } =
        await supabase
            .from(
                "opposition_case_drafts"
            )
            .select(
                "id, version_no, stage, content, qa_report, generation_context, generated_by, created_at"
            )
            .eq(
                "opposition_case_id",
                oppositionCaseId,
            )
            .order(
                "version_no",
                {
                    ascending:
                        false,
                },
            )
            .limit(10);

    if (error) {

        throw new Error(
            `Dilekçe versiyonları okunamadı: ${error.message}`,
        );
    }

    return data ?? [];
}

async function buildStatus(
    supabase: ReturnType<typeof createClient>,
    supabaseUrl: string,
    token: string,
    taskId: string,
) {

    const analysis =
        await loadAnalysisContext(
            supabaseUrl,
            token,
            taskId,
        );

    const caseMeta =
        await loadCaseMeta(
            supabase,
            taskId,
        );

    const canonical =
        buildCanonicalPayload(
            analysis,
            caseMeta,
        );

    const drafts =
        await loadDraftHistory(
            supabase,
            caseMeta.oppositionCase.id,
        );

    const documentData =
        buildProfessionalDocumentData(
            caseMeta,
            canonical,
        );

    return {

        canGenerate:
            canonical.canGenerate,

        blockers:
            canonical.blockers,

        warnings:
            canonical.warnings,

        stale:
            analysis?.stale === true,

        caseStatus:
            caseMeta.oppositionCase.status,

        currentVersion:
            Number(
                caseMeta
                    .oppositionCase
                    .draft_version ??
                0
            ),

        currentDraft:
            caseMeta
                .oppositionCase
                .current_draft ??
            null,

        drafts,

        documentData,

        wordData: {

            clientName:
                caseMeta.clientName ||
                "Müvekkil",

            opponentName:
                caseMeta.opponentName ||
                "Karşı Taraf",

            opponentMark:
                analysis
                    ?.opponent
                    ?.markText ||
                "Belirtilmemiş",

            opponentAppNo:
                analysis
                    ?.opponent
                    ?.applicationNo ||
                "Belirtilmemiş",

            bulletinNo:
                caseMeta.bulletinNo,

            bulletinDate:
                caseMeta.bulletinDate,

            opponentImageUrl:
                caseMeta.opponentImageUrl,

            priorMarks:
                documentData.priorMarks,

            refusalScopes:
                documentData.refusalScopes,

            goodsComparisons:
                documentData.goodsComparisons,

            topicText:
                documentData.topicText,

            resultItems:
                documentData.resultItems,
        },

        selectedRefusalClasses:
            canonical
                .selectedRefusalClasses,

        selectedRefusalScopes:
            canonical
                .selectedRefusalScopes,
    };
}

async function nextVersion(
    supabase: ReturnType<typeof createClient>,
    oppositionCase: any,
) {

    const {
        data,
        error,
    } =
        await supabase
            .from(
                "opposition_case_drafts"
            )
            .select(
                "version_no"
            )
            .eq(
                "opposition_case_id",
                oppositionCase.id,
            )
            .order(
                "version_no",
                {
                    ascending:
                        false,
                },
            )
            .limit(1)
            .maybeSingle();

    if (error) {

        throw new Error(
            `Son dilekçe versiyonu okunamadı: ${error.message}`,
        );
    }

    return Math.max(

        Number(
            oppositionCase
                .draft_version ??
            0
        ),

        Number(
            data?.version_no ??
            0
        ),

    ) + 1;
}

async function persistDraft(
    supabase: ReturnType<typeof createClient>,
    userId: string,
    caseMeta: any,
    canonical: any,
    generation: any,
    qaReport: any,
) {

    const versionNo =
        await nextVersion(
            supabase,
            caseMeta.oppositionCase,
        );

    const {
        error: insertError,
    } =
        await supabase
            .from(
                "opposition_case_drafts"
            )
            .insert({

                opposition_case_id:
                    caseMeta
                        .oppositionCase
                        .id,

                version_no:
                    versionNo,

                stage:
                    "generated",

                content:
                    generation.petition,

                generation_context: {

                    sourceFingerprint:
                        canonical
                            .payload
                            .sourceFingerprint,

                    selectedGrounds:
                        canonical
                            .payload
                            .selectedGrounds,

                    selectedRefusalClasses:
                        canonical
                            .selectedRefusalClasses,

                    selectedRefusalScopes:
                        canonical
                            .selectedRefusalScopes,

                    payloadSnapshot:
                        canonical.payload,

                    packageVersion:
                        "5.1",

                    legalResearchPackageVersion:
                        generation
                            ?.generationCache
                            ?.packageVersion ??
                        generation
                            ?.packageVersion ??
                        "6.0",

                    legalCorpusFingerprint:
                        generation
                            ?.generationCache
                            ?.legalCorpusFingerprint ??
                        null,

                    documentDataSnapshot:
                        buildProfessionalDocumentData(
                            caseMeta,
                            canonical,
                        ),

                    analysisCacheKey:
                        generation
                            ?.generationCache
                            ?.cacheKey ??
                        null,

                    telemetry:
                        generation
                            ?.telemetry ??
                        null,

                    legalSources:
                        generation
                            ?.sources ??
                        [],

                    citationAudit:
                        generation
                            ?.citationAudit ??
                        null,

                    ragSourceIds:
                        (
                            generation.sources ??
                            []
                        ).map(
                            (source: any) =>
                                source.sourceId
                        ),
                },

                qa_report:
                    qaReport,

                generated_by:
                    userId,
            });

    if (insertError) {

        throw new Error(
            `Dilekçe versiyonu kaydedilemedi: ${insertError.message}`,
        );
    }

    const {
        error: updateError,
    } =
        await supabase
            .from(
                "opposition_cases"
            )
            .update({

                ai_analysis: {
                    ...(
                        generation.analysis ??
                        {}
                    ),

                    _generationCache:
                        generation
                            ?.generationCache ??
                        null,

                    // Geriye dönük uyumluluk: eski frontend/iş akışları
                    // _package42 alanını okuyabilir. İçerik artık P6 cache olabilir.
                    _package42:
                        generation
                            ?.generationCache ??
                        null,

                    _lastCitationAudit:
                        generation
                            ?.citationAudit ??
                        null,

                    _lastLegalSources:
                        generation
                            ?.sources ??
                        [],

                    _lastTelemetry:
                        generation
                            ?.telemetry ??
                        null,
                },

                qa_report:
                    qaReport,

                current_draft:
                    generation.petition,

                draft_version:
                    versionNo,

                status:
                    "review",
            })
            .eq(
                "id",
                caseMeta
                    .oppositionCase
                    .id,
            );

    if (updateError) {

        throw new Error(
            `Opposition Case taslak kaydı güncellenemedi: ${updateError.message}`,
        );
    }

    return versionNo;
}

async function generate(
    supabase: ReturnType<typeof createClient>,
    supabaseUrl: string,
    userId: string,
    token: string,
    taskId: string,
) {

    const analysis =
        await loadAnalysisContext(
            supabaseUrl,
            token,
            taskId,
        );

    const caseMeta =
        await loadCaseMeta(
            supabase,
            taskId,
        );

    const canonical =
        buildCanonicalPayload(
            analysis,
            caseMeta,
        );

    if (
        !canonical.canGenerate
    ) {

        throw new HttpError(
            422,
            `Dilekçe üretimi engellendi: ${canonical.blockers.join(" | ")}`,
        );
    }

    const generationPayload = {
        ...canonical.payload,

        _generationCache:
            caseMeta
                ?.oppositionCase
                ?.ai_analysis
                ?._generationCache ??
            caseMeta
                ?.oppositionCase
                ?.ai_analysis
                ?._package42 ??
            null,
    };


    const generationResponse =
        await callFunction(
            supabaseUrl,
            "generate-petition",
            token,
            generationPayload,
        );

    if (
        generationResponse.status ===
        "needs_input"
    ) {

        return {

            generationStatus:
                "needs_input",

            saved:
                false,

            missingCriticalFacts:
                generationResponse
                    .missingCriticalFacts ??
                generationResponse
                    .analysis
                    ?.missingCriticalFacts ??
                [],

            analysis:
                generationResponse
                    .analysis ??
                null,

            telemetry:
                generationResponse
                    .telemetry ??
                null,
        };
    }

    if (
        !generationResponse.petition
    ) {

        throw new HttpError(
            422,
            "AI dilekçe metni üretmedi.",
        );
    }

    const deterministic =
        deterministicDraftQa(
            generationResponse.petition,
            canonical.payload,
        );

    const citationAudit =
        generationResponse
            ?.citationAudit ?? {
                version:
                    0,
                packageVersion:
                    generationResponse
                        ?.packageVersion ??
                    "6.0",
                pass:
                    true,
                blockers:
                    [],
                warnings:
                    [
                        "Citation audit bilgisi dönmedi; legacy compatibility mode.",
                    ],
                citedSourceIds:
                    [],
                citableSourcesAvailable:
                    0,
            };


    const qaReport = {

        version:
            3,

        // Paket 5.1 Word export güvenlik kilidi bu değeri bekliyor.
        // Hukuk araştırma paketi ayrı alanda sürümlenir.
        packageVersion:
            "4.2",

        legalResearchPackageVersion:
            generationResponse
                ?.packageVersion ??
            generationResponse
                ?.generationCache
                ?.packageVersion ??
            "6.0",

        deterministic,

        citationAudit,

        aiAuditIssues:
            generationResponse
                .auditIssues ??
            [],

        aiTelemetry:
            generationResponse
                .telemetry ??
            null,

        analysisCacheUsed:
            generationResponse
                ?.telemetry
                ?.cache
                ?.hit === true,

        finalPass:
            deterministic.pass &&
            citationAudit.pass !==
            false,

        checkedAt:
            new Date().toISOString(),
    };

    if (
        !qaReport.finalPass
    ) {

        return {

            generationStatus:
                "qa_failed",

            saved:
                false,

            petition:
                generationResponse.petition,

            analysis:
                generationResponse
                    .analysis ??
                null,

            qaReport,

            citationAudit,

            sources:
                generationResponse
                    ?.sources ??
                [],

            telemetry:
                generationResponse
                    .telemetry ??
                null,
        };
    }

    const versionNo =
        await persistDraft(
            supabase,
            userId,
            caseMeta,
            canonical,
            generationResponse,
            qaReport,
        );

    return {

        generationStatus:
            "completed",

        saved:
            true,

        versionNo,

        petition:
            generationResponse.petition,

        analysis:
            generationResponse
                .analysis ??
            null,

        qaReport,

        citationAudit,

        sources:
            generationResponse
                ?.sources ??
            [],

        telemetry:
            generationResponse
                .telemetry ??
            null,
    };
}

serve(async (req) => {

    if (
        req.method ===
        "OPTIONS"
    ) {

        return new Response(
            "ok",
            {
                headers:
                    corsHeaders,
            },
        );
    }

    try {

        const supabaseUrl =
            Deno.env.get(
                "SUPABASE_URL"
            ) ??
            "";

        const serviceRoleKey =
            Deno.env.get(
                "SUPABASE_SERVICE_ROLE_KEY"
            ) ??
            "";

        const supabase =
            createClient(
                supabaseUrl,
                serviceRoleKey,
                {
                    auth: {

                        autoRefreshToken:
                            false,

                        persistSession:
                            false,
                    },
                },
            );

        const currentUser =
            await assertInternalUser(
                req,
                supabase,
            );

        const body =
            await req.json();

        const action =
            String(
                body.action ??
                "status"
            );

        const taskId =
            String(
                body.taskId ??
                ""
            ).trim();

        if (!taskId) {

            throw new HttpError(
                400,
                "taskId zorunludur.",
            );
        }

        if (
            action ===
            "status"
        ) {

            const status =
                await buildStatus(
                    supabase,
                    supabaseUrl,
                    currentUser.token,
                    taskId,
                );

            return new Response(
                JSON.stringify({
                    success:
                        true,

                    status,
                }),
                {
                    headers: {

                        ...corsHeaders,

                        "Content-Type":
                            "application/json",
                    },
                },
            );
        }

        if (
            action ===
            "generate"
        ) {

            const generation =
                await generate(
                    supabase,
                    supabaseUrl,
                    currentUser.id,
                    currentUser.token,
                    taskId,
                );

            const status =
                await buildStatus(
                    supabase,
                    supabaseUrl,
                    currentUser.token,
                    taskId,
                );

            return new Response(
                JSON.stringify({

                    success:
                        true,

                    generation,

                    status,
                }),
                {
                    headers: {

                        ...corsHeaders,

                        "Content-Type":
                            "application/json",
                    },
                },
            );
        }

        throw new HttpError(
            400,
            "Geçersiz action.",
        );

    } catch (error) {

        const status =
            error instanceof HttpError

                ? (
                    [401, 403].includes(
                        error.status
                    )
                        ? error.status
                        : 200
                )

                : 500;

        const message =
            error instanceof Error
                ? error.message
                : "Bilinmeyen hata";

        console.error(
            "❌ opposition-draft:",
            message,
        );

        return new Response(
            JSON.stringify({

                success:
                    false,

                error:
                    message,
            }),
            {
                status,

                headers: {

                    ...corsHeaders,

                    "Content-Type":
                        "application/json",
                },
            },
        );
    }
});