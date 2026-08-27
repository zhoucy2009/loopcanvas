import Foundation

enum RequirementAnalyzer {
    static func directives(in text: String) -> [RequirementDirective] {
        let separators = CharacterSet(charactersIn: "。；;\n")
        return text.components(separatedBy: separators)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .compactMap { clause in
                let strength: RequirementDirectiveStrength?
                if clause.contains("不要") || clause.contains("禁止") || clause.contains("不能") {
                    strength = .forbidden
                } else if clause.contains("必须") || clause.contains("需要") || clause.contains("务必") {
                    strength = .required
                } else if clause.contains("我想") || clause.contains("我希望") || clause.contains("采用") || clause.contains("使用") || clause.contains("方案") {
                    strength = .preferred
                } else {
                    strength = nil
                }
                guard let strength else { return nil }
                return RequirementDirective(id: UUID(), text: clause, strength: strength, source: "用户原始需求")
            }
    }
}
