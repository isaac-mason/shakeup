// Port of the oxc_syntax flag sets the minifier reads: `ReferenceFlags`, `ScopeFlags`, `SymbolFlags`.

export const ReferenceFlags = {
    None: 0,
    Read: 1 << 0,
    Write: 1 << 1,
    Type: 1 << 2,
    ValueAsType: 1 << 3,
    Namespace: 1 << 4,
    MemberWriteTarget: 1 << 5,
    Value: (1 << 0) | (1 << 1),
} as const;

export const referenceIsRead = (flags: number): boolean => (flags & ReferenceFlags.Read) !== 0;
export const referenceIsReadOnly = (flags: number): boolean => (flags & ReferenceFlags.Write) === 0;
export const referenceIsWrite = (flags: number): boolean => (flags & ReferenceFlags.Write) !== 0;
export const referenceIsWriteOnly = (flags: number): boolean =>
    (flags & ReferenceFlags.Write) !== 0 && (flags & ReferenceFlags.Read) === 0;
export const referenceIsReadWrite = (flags: number): boolean => (flags & ReferenceFlags.Value) === ReferenceFlags.Value;
export const referenceIsMemberWriteTarget = (flags: number): boolean => (flags & ReferenceFlags.MemberWriteTarget) !== 0;
export const referenceIsTypeOnly = (flags: number): boolean => flags === ReferenceFlags.Type;
export const referenceIsValue = (flags: number): boolean => (flags & ReferenceFlags.Value) !== 0;

export const ScopeFlags = {
    StrictMode: 1 << 0,
    Top: 1 << 1,
    Function: 1 << 2,
    Arrow: 1 << 3,
    ClassStaticBlock: 1 << 4,
    TsModuleBlock: 1 << 5,
    Constructor: 1 << 6,
    GetAccessor: 1 << 7,
    SetAccessor: 1 << 8,
    CatchClause: 1 << 9,
    DirectEval: 1 << 10,
    TsConditional: 1 << 11,
    With: 1 << 12,
    Var: (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5),
} as const;

export const scopeIsStrictMode = (flags: number): boolean => (flags & ScopeFlags.StrictMode) !== 0;
export const scopeIsBlock = (flags: number): boolean => flags === 0 || flags === ScopeFlags.StrictMode;
export const scopeIsTop = (flags: number): boolean => (flags & ScopeFlags.Top) !== 0;
export const scopeIsFunction = (flags: number): boolean => (flags & ScopeFlags.Function) !== 0;
export const scopeIsArrow = (flags: number): boolean => (flags & ScopeFlags.Arrow) !== 0;
export const scopeIsConstructor = (flags: number): boolean => (flags & ScopeFlags.Constructor) !== 0;
export const scopeIsClassStaticBlock = (flags: number): boolean => (flags & ScopeFlags.ClassStaticBlock) !== 0;
export const scopeIsVar = (flags: number): boolean => (flags & ScopeFlags.Var) !== 0;
export const scopeIsSetOrGetAccessor = (flags: number): boolean =>
    (flags & (ScopeFlags.SetAccessor | ScopeFlags.GetAccessor)) !== 0;
export const scopeIsCatchClause = (flags: number): boolean => (flags & ScopeFlags.CatchClause) !== 0;
export const scopeContainsDirectEval = (flags: number): boolean => (flags & ScopeFlags.DirectEval) !== 0;

export const SymbolFlags = {
    None: 0,
    FunctionScopedVariable: 1 << 0,
    BlockScopedVariable: 1 << 1,
    ConstVariable: 1 << 2,
    Class: 1 << 3,
    CatchVariable: 1 << 4,
    Function: 1 << 5,
    Import: 1 << 6,
    TypeImport: 1 << 7,
    TypeAlias: 1 << 8,
    Interface: 1 << 9,
    RegularEnum: 1 << 10,
    ConstEnum: 1 << 11,
    EnumMember: 1 << 12,
    TypeParameter: 1 << 13,
    NamespaceModule: 1 << 14,
    ValueModule: 1 << 15,
    Ambient: 1 << 16,
    FunctionExpression: 1 << 17,
    AsyncOrGeneratorFunction: 1 << 18,
} as const;

const SYMBOL_ENUM = SymbolFlags.ConstEnum | SymbolFlags.RegularEnum;
const SYMBOL_VARIABLE = SymbolFlags.FunctionScopedVariable | SymbolFlags.BlockScopedVariable;
const SYMBOL_BLOCK_SCOPED = SymbolFlags.BlockScopedVariable | SYMBOL_ENUM | SymbolFlags.Class;
const SYMBOL_VALUE =
    SYMBOL_VARIABLE | SymbolFlags.Class | SymbolFlags.Function | SYMBOL_ENUM | SymbolFlags.EnumMember | SymbolFlags.ValueModule;

export const symbolIsVariable = (flags: number): boolean => (flags & SYMBOL_VARIABLE) !== 0;
export const symbolIsValue = (flags: number): boolean => (flags & (SYMBOL_VALUE | SymbolFlags.Import)) !== 0;
export const symbolIsConstVariable = (flags: number): boolean => (flags & SymbolFlags.ConstVariable) !== 0;
export const symbolIsFunction = (flags: number): boolean => (flags & SymbolFlags.Function) !== 0;
export const symbolIsClass = (flags: number): boolean => (flags & SymbolFlags.Class) !== 0;
export const symbolIsBlockScoped = (flags: number): boolean => (flags & SYMBOL_BLOCK_SCOPED) !== 0;
export const symbolIsCatchVariable = (flags: number): boolean => (flags & SymbolFlags.CatchVariable) !== 0;
export const symbolIsFunctionScopedDeclaration = (flags: number): boolean => (flags & SymbolFlags.FunctionScopedVariable) !== 0;
export const symbolIsImport = (flags: number): boolean => (flags & (SymbolFlags.Import | SymbolFlags.TypeImport)) !== 0;
export const symbolIsTypeImport = (flags: number): boolean => (flags & SymbolFlags.TypeImport) !== 0;
