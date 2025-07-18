import node from "eslint-plugin-node";
import promise from "eslint-plugin-promise";
import proposal from "eslint-plugin-proposal";
import { fixupPluginRules } from "@eslint/compat";
import globals from "globals";
import babelParser from "@babel/eslint-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [{
    ignores: ["**/public/", "**/node_modules/", "**/bin/", "**/output/"],
}, ...compat.extends("eslint:recommended", "plugin:proposal/recommended", "airbnb-base"), {
    plugins: {
        node: fixupPluginRules(node),
        promise,
        proposal,
    },

    languageOptions: {
        globals: {
            ...globals.browser,
            ...globals.commonjs,
            ...globals.jquery,
            ...globals.node,
            document: "readonly",
            navigator: "readonly",
            window: "readonly",
            _: true,
        },

        parser: babelParser,
        ecmaVersion: 2020,
        sourceType: "module",

        parserOptions: {
            requireConfigFile: false,
            babelOptions: {},
        },
    },

    rules: {
        "accessor-pairs": "error",
        "array-bracket-spacing": ["error", "never"],

        "arrow-spacing": ["error", {
            before: true,
            after: true,
        }],

        "block-spacing": ["error", "always"],

        "brace-style": ["error", "1tbs", {
            allowSingleLine: true,
        }],

        camelcase: "off",

        "comma-dangle": ["error", {
            arrays: "never",
            objects: "never",
            imports: "never",
            exports: "never",
            functions: "never",
        }],

        "comma-spacing": ["error", {
            before: false,
            after: true,
        }],

        "comma-style": ["error", "last"],
        "computed-property-spacing": ["error", "never"],
        "consistent-return": "off",
        "constructor-super": "error",
        curly: ["error", "multi-line"],
        "default-param-last": "off",
        "dot-location": ["error", "property"],

        "dot-notation": ["error", {
            allowKeywords: true,
        }],

        "eol-last": "error",

        eqeqeq: ["error", "always", {
            null: "ignore",
        }],

        "func-call-spacing": ["error", "never"],

        "generator-star-spacing": ["error", {
            before: true,
            after: true,
        }],

        "handle-callback-err": ["error", "^(err|error)$"],
        "implicit-arrow-linebreak": "off",

        indent: ["error", 2, {
            SwitchCase: 1,
            VariableDeclarator: 1,
            outerIIFEBody: 1,
            MemberExpression: 1,

            FunctionDeclaration: {
                parameters: 1,
                body: 1,
            },

            FunctionExpression: {
                parameters: 1,
                body: 1,
            },

            CallExpression: {
                arguments: 1,
            },

            ArrayExpression: 1,
            ObjectExpression: 1,
            ImportDeclaration: 1,
            flatTernaryExpressions: false,
            ignoreComments: false,
            ignoredNodes: ["TemplateLiteral *"],
        }],

        "key-spacing": ["error", {
            beforeColon: false,
            afterColon: true,
        }],

        "keyword-spacing": ["error", {
            before: true,
            after: true,
        }],

        "lines-between-class-members": ["error", "always", {
            exceptAfterSingleLine: true,
        }],

        "max-len": "off",

        "new-cap": ["error", {
            newIsCap: true,
            capIsNew: false,
            properties: true,
        }],

        "new-parens": "error",
        "no-array-constructor": "error",
        "no-async-promise-executor": 0,
        "no-await-in-loop": 0,
        "no-caller": "error",
        "no-case-declarations": "error",
        "no-class-assign": "error",
        "no-compare-neg-zero": "error",
        "no-cond-assign": "error",
        "no-console": "off",
        "no-const-assign": "error",

        "no-constant-condition": ["error", {
            checkLoops: false,
        }],

        "no-control-regex": "error",
        "no-debugger": "error",
        "no-delete-var": "error",
        "no-dupe-args": "error",
        "no-dupe-class-members": "error",
        "no-dupe-keys": "error",
        "no-duplicate-case": "error",
        "no-empty-character-class": "error",
        "no-empty-pattern": "error",
        "no-eval": "error",
        "no-ex-assign": "error",
        "no-extend-native": "off",
        "no-extra-bind": "error",
        "no-extra-boolean-cast": "error",
        "no-extra-parens": ["error", "functions"],
        "no-fallthrough": "error",
        "no-floating-decimal": "error",
        "no-func-assign": "error",
        "no-global-assign": "error",
        "no-implied-eval": "error",
        "no-inner-declarations": ["error", "functions"],
        "no-invalid-regexp": "error",
        "no-irregular-whitespace": "error",
        "no-iterator": "error",

        "no-labels": ["error", {
            allowLoop: false,
            allowSwitch: false,
        }],

        "no-lone-blocks": "error",
        "no-misleading-character-class": "error",
        "no-promise-executor-return": 0,
        "no-prototype-builtins": "error",
        "no-useless-catch": "error",

        "no-mixed-operators": ["error", {
            groups: [
                ["==", "!=", "===", "!==", ">", ">=", "<", "<="],
                ["&&", "||"],
                ["in", "instanceof"],
            ],

            allowSamePrecedence: true,
        }],

        "no-mixed-spaces-and-tabs": "error",
        "no-multi-spaces": "error",
        "no-multi-str": "error",

        "no-multiple-empty-lines": ["error", {
            max: 1,
            maxEOF: 0,
        }],

        "no-negated-in-lhs": "error",
        "no-new": "error",
        "no-new-func": "error",
        "no-new-object": "error",
        "no-new-require": "error",
        "no-new-symbol": "error",
        "no-new-wrappers": "error",
        "no-obj-calls": "error",
        "no-octal": "error",
        "no-octal-escape": "error",
        "no-param-reassign": "off",
        "no-path-concat": "error",
        "no-proto": "error",

        "no-redeclare": ["error", {
            builtinGlobals: false,
        }],

        "no-regex-spaces": "error",
        "no-return-assign": ["error", "except-parens"],
        "no-return-await": "error",

        "no-self-assign": ["error", {
            props: true,
        }],

        "no-self-compare": "error",
        "no-sequences": "error",
        "no-shadow": "off",
        "no-shadow-restricted-names": "error",
        "no-sparse-arrays": "error",
        "no-tabs": "error",
        "no-template-curly-in-string": "error",
        "no-this-before-super": "error",
        "no-throw-literal": "error",
        "no-trailing-spaces": "error",
        "no-undef": "error",
        "no-undef-init": "error",
        "no-underscore-dangle": "off",
        "no-unexpected-multiline": "error",
        "no-unmodified-loop-condition": "error",

        "no-unneeded-ternary": ["error", {
            defaultAssignment: false,
        }],

        "no-unreachable": "error",
        "no-unsafe-finally": 0,
        "no-unsafe-negation": "error",

        "no-unused-expressions": ["error", {
            allowShortCircuit: true,
            allowTernary: true,
            allowTaggedTemplates: true,
        }],

        "no-unused-vars": ["error", {
            vars: "all",
            args: "none",
            ignoreRestSiblings: true,
        }],

        "no-use-before-define": ["error", {
            functions: false,
            classes: false,
            variables: false,
        }],

        "no-useless-call": "error",
        "no-useless-computed-key": "error",
        "no-useless-constructor": "error",
        "no-useless-escape": "error",
        "no-useless-rename": "error",
        "no-useless-return": "error",
        "no-void": "error",
        "no-whitespace-before-property": "error",
        "no-with": "error",

        "object-curly-newline": ["error", {
            multiline: true,
            consistent: true,
        }],

        "object-curly-spacing": ["error", "always"],

        "object-property-newline": ["error", {
            allowMultiplePropertiesPerLine: true,
        }],

        "one-var": ["error", {
            initialized: "never",
        }],

        "operator-linebreak": ["error", "after", {
            overrides: {
                "?": "before",
                ":": "before",
                "|>": "before",
            },
        }],

        "padded-blocks": ["error", {
            blocks: "never",
            switches: "never",
            classes: "never",
        }],

        "prefer-const": ["error", {
            destructuring: "all",
        }],

        "prefer-destructuring": "off",
        "prefer-promise-reject-errors": "error",
        "quote-props": ["error", "as-needed"],

        quotes: ["error", "single", {
            avoidEscape: true,
            allowTemplateLiterals: true,
        }],

        "rest-spread-spacing": ["error", "never"],
        semi: ["warn", "always"],

        "semi-spacing": ["error", {
            before: false,
            after: true,
        }],

        "space-before-blocks": ["error", "always"],
        "space-before-function-paren": ["error", "always"],
        "space-in-parens": ["error", "never"],
        "space-infix-ops": "error",

        "space-unary-ops": ["error", {
            words: true,
            nonwords: false,
        }],

        "spaced-comment": ["error", "always", {
            line: {
                markers: ["*package", "!", "/", ",", "="],
            },

            block: {
                balanced: true,
                markers: ["*package", "!", ",", ":", "::", "flow-include"],
                exceptions: ["*"],
            },
        }],

        "symbol-description": "error",
        "template-curly-spacing": ["error", "never"],
        "template-tag-spacing": ["error", "never"],
        "unicode-bom": ["error", "never"],
        "use-isnan": "error",

        "valid-typeof": ["error", {
            requireStringLiterals: true,
        }],

        "wrap-iife": ["error", "any", {
            functionPrototypeMethods: true,
        }],

        "yield-star-spacing": ["error", "both"],
        yoda: ["error", "never"],
        "import/export": "error",
        "import/first": "error",

        "import/no-absolute-path": ["error", {
            esmodule: true,
            commonjs: true,
            amd: false,
        }],

        "import/no-cycle": "off",
        "import/no-duplicates": "error",
        "import/no-named-default": "error",
        "import/no-webpack-loader-syntax": "error",
        "import/prefer-default-export": "off",
        "node/no-deprecated-api": "error",
        "node/process-exit-as-throw": "error",
        "promise/param-names": "error",
    },
}];